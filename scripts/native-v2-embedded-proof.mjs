// TEST-only proof of pinned OpenCode V2 embedded durable event retention.
// No native CLI, user credentials, external provider or production activation.
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const receiptPath = resolve(process.env.OPENCODE_V2_EMBEDDED_RECEIPT || 'native-v2-embedded-proof.json')
const prefix = process.env.OPENCODE_V2_EMBEDDED_NPM_PREFIX
const modelMode = process.env.OPENCODE_V2_EMBEDDED_MODEL_PROOF === '1'
const toolMode = process.env.OPENCODE_V2_EMBEDDED_TOOL_PROOF === '1'
const interruptMode = process.env.OPENCODE_V2_EMBEDDED_INTERRUPT_PROOF === '1'
const expectedPlatform = process.env.OPENCODE_V2_TEST_EXPECTED_PLATFORM
const pinnedVersion = process.env.OPENCODE_V2_EMBEDDED_VERSION || '2.0.21'
if (!['2.0.0', '2.0.21', '2.1.4'].includes(pinnedVersion)) throw Error('TEST_unqualified_embedded_version')
// V2.0.21 exercises explicit session deny. Only V2.1.4 has top-level
// hard-deny `policies`; these are separate tests, never a fallback.
if (toolMode && (!modelMode || !['2.0.21', '2.1.4'].includes(pinnedVersion)))
  throw Error('TEST_tool_policy_requires_supported_embedded_model')
if (interruptMode && (!modelMode || toolMode || pinnedVersion !== '2.0.21'))
  throw Error('TEST_interrupt_requires_pinned_embedded_model')
const receipt = { kind: 'TEST_V2_EMBEDDED_DURABLE_DISCOVERY_ONLY', version: pinnedVersion,
  qualified: false, steps: [], cleanup: false }
const root = mkdtempSync(join(tmpdir(), 'TEST-v2-embedded-'))
for (const dir of ['workspace', 'home', 'config', 'cache', 'data', 'state', 'temp']) {
  mkdirSync(join(root, dir), { recursive: true })
}
const workspace = join(root, 'workspace'), database = join(root, 'data', 'embedded.sqlite')
let host, fake
let modelCalls = 0, fakeFailure = null, allowInference = false, earlyModelRequests = 0
let toolPhase = false, toolModelRequests = 0, advertisedToolNames = []
let toolCallIssued = false, toolRequestProfiles = []
let toolExecutorCalls = 0, toolAuthorizedCalls = 0, toolPermissionRejections = []
let interruptArmed = false, interruptStream, notifyInterruptStream
let toolPluginSetupCalls = 0, toolRegisteredNames = []
let toolContextCalls = 0, toolContextNames = []
const toolCanary = 'TEST_DO_NOT_READ_OUTSIDE_' + process.pid
let toolTargetPath = join(root, 'outside-canary.txt')
let failed = false
// The embedded module must never see user/runner credentials, provider keys or ambient config.
// Preserve only the executable lookup path (case-insensitive on Windows) and locale.
const safePath = process.env.PATH ?? process.env.Path ?? ''
for (const key of Object.keys(process.env)) {
  if (!['LANG', 'TZ'].includes(key)) delete process.env[key]
}
Object.assign(process.env, {
  PATH: safePath,
  HOME: join(root, 'home'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_STATE_HOME: join(root, 'state'),
  TMPDIR: join(root, 'temp'),
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  CI: 'true',
  NO_COLOR: '1',
  ...(process.platform === 'win32' ? {
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'config'),
    LOCALAPPDATA: join(root, 'data'),
    TMP: join(root, 'temp'),
    TEMP: join(root, 'temp'),
  } : {}),
})
const options = {
  app: { name: 'TEST-embedded-native-v2', version: pinnedVersion },
  database: { path: database },
  events: { persist: true },
  models: { fetch: false },
  config: { directory: join(root, 'config'), project: false },
  fs: { filewatcher: false, fff: false },
}
async function readLog(sdk, sessionID) {
  const events = []
  for await (const value of sdk.sessions.log({ sessionID, follow: false },
    { signal: AbortSignal.timeout(12_000) })) {
    const event = value?.type ? value : value?.data
    if (typeof event?.type !== 'string' || events.length >= 256)
      throw Error('TEST_embedded_log_invalid_or_unbounded')
    events.push(event)
  }
  if (events.at(-1)?.type !== 'log.synced' ||
      events.at(-1)?.aggregateID !== sessionID ||
      !Number.isSafeInteger(events.at(-1)?.seq))
    throw Error('TEST_embedded_log_missing_owned_sync')
  return events
}
try {
  if (expectedPlatform !== `${process.platform}-${process.arch}`)
    throw Error('TEST_embedded_runner_platform_mismatch')
  if (typeof prefix !== 'string' || !isAbsolute(prefix)) throw Error('TEST_embedded_prefix_not_absolute')
  const packageRoot = realpathSync(join(prefix, 'node_modules', '@opencode', 'sdk'))
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== '@opencode/sdk' || manifest.version !== pinnedVersion)
    throw Error('TEST_embedded_SDK_package_identity')
  // Resolve only the published ESM export; require.resolve follows the absent CJS condition.
  const exported = manifest.exports?.['.']
  const target = typeof exported === 'string' ? exported
    : typeof exported?.import === 'string' ? exported.import
    : typeof exported?.import?.default === 'string' ? exported.import.default
    : exported?.default
  if (typeof target !== 'string' || !target.startsWith('./'))
    throw Error('TEST_embedded_SDK_ESM_export_missing')
  const entry = realpathSync(join(packageRoot, target))
  if (!entry.startsWith(packageRoot + sep)) throw Error('TEST_embedded_SDK_export_outside_package')
  const { OpenCode } = await import(pathToFileURL(entry).href)
  if (typeof OpenCode?.create !== 'function') throw Error('TEST_embedded_api_unavailable')
  if (toolMode && pinnedVersion === '2.1.4') {
    // V2-native Promise plugin API only, not a renamed V1 plugin. This
    // disposable tool never reads a file; its real native permission assert
    // must deny the external path before the synthetic executor can return.
    const effectEntry = realpathSync(createRequire(join(packageRoot, 'package.json')).resolve('effect'))
    if (!effectEntry.startsWith(realpathSync(join(prefix, 'node_modules')) + sep))
      throw Error('TEST_embedded_effect_outside_pinned_prefix')
    const { Schema } = await import(pathToFileURL(effectEntry).href)
    if (typeof Schema?.Struct !== 'function') throw Error('TEST_embedded_native_plugin_schema_unavailable')
    options.plugins = [{
      id: 'TEST-v2-owned-native-tool',
      setup: async (ctx) => {
        toolPluginSetupCalls++
        await ctx.tool.transform(editor => {
          editor.add({
            name: 'read',
            description: 'TEST-only synthetic read permission probe (never opens files)',
            options: { codemode: false },
            input: Schema.Struct({ filePath: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: async ({ filePath }, context) => {
              toolExecutorCalls++
              try {
                await ctx.permission.assert({
                  sessionID: context.sessionID, agent: context.agent,
                  action: 'external_directory', resources: [filePath],
                })
              } catch (error) {
                // Never record the path, error text, policy document or canary.
                toolPermissionRejections.push({
                  name: typeof error?.name === 'string' ? error.name.slice(0, 80) : null,
                  policyDenied: typeof error?.message === 'string' &&
                    error.message.includes(pinnedVersion === '2.1.4'
                      ? 'Blocked by configuration policy' : 'Permission denied: external_directory'),
                })
                throw error
              }
              toolAuthorizedCalls++
              return { output: { text: 'TEST_CONTROLLED_EXECUTION' }, content: 'TEST_CONTROLLED_EXECUTION' }
            },
          })
        })
        toolRegisteredNames = (await ctx.tool.list())
          .map(tool => tool.id).filter(name => typeof name === 'string')
          .slice(0, 64).map(name => name.slice(0, 80))
        // The native session context hook observes effective tool discovery
        // before the provider request; do not mutate the tool definitions.
        await ctx.session.hook('context', event => {
          if (!toolPhase) return
          toolContextCalls++
          toolContextNames = Object.keys(event.tools ?? {}).slice(0, 64)
            .map(name => name.slice(0, 80))
        })
      },
    }]
    receipt.steps.push('TEST_embedded_v2_native_tool_plugin_configured')
  } else if (toolMode) {
    // 2.0.21 has no Promise ctx.permission.assert. Use its actual built-in
    // read tool, whose FileAccess.authorizeRead checks session permissions.
    receipt.steps.push('TEST_embedded_pinned_builtin_read_selected')
  }
  receipt.steps.push('pinned_embedded_SDK_module_resolved')
  if (pinnedVersion === '2.0.21') {
    // The private V2 SPI must accept this machine's actual absolute workspace
    // path. This is config admission only, not a Host/executable custody proof.
    const { snapshotDriverConfig } = await import('../packages/provider-implementations/src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-config.ts')
    const binding = { tenantId: 'TEST-tenant', projectId: 'TEST-project',
      sessionId: 'TEST-runtime', generation: 1 }
    const config = { endpoint: 'http://127.0.0.1:14321', directory: workspace,
      nativeSessionId: 'ses_TESTowned', version: '2.0.21',
      trustedBinding: 'TEST-host', accountBinding: 'TEST-account', configRevision: 'TEST-r1',
      readPassword: () => 'TEST-private',
      binding, limits: { queuedInputs: 2, inputBytes: 4096, outputBytes: 32768,
        outputEvents: 64, pendingInteractions: 2, timeoutMs: 2000 },
      probe: async () => true, confirmStopped: async () => true }
    const accepted = snapshotDriverConfig(config, { ...binding, configRevision: 'TEST-r1',
      requiredCapabilities: ['text'] })
    if (accepted.directory !== workspace || !isAbsolute(accepted.directory))
      throw Error('TEST_native_SPI_workspace_admission_failed')
    receipt.steps.push('TEST_native_SPI_platform_absolute_directory_admitted')
  }
  if (modelMode) {
    const modelID = 'TEST-native-model', providerID = 'test-native'
    const marker = 'TEST_V2_EMBEDDED_LOCAL_REPLY'
    fake = createServer((request, response) => {
      // No inference, including loopback-only inference, is admitted until the
      // exact TEST model and owned session have been positively selected.
      if (!allowInference) {
        earlyModelRequests++
        fakeFailure = 'TEST_inference_before_explicit_admission'
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end('{"error":"TEST_not_admitted"}')
        return
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        fakeFailure = 'unexpected_TEST_model_route'
        response.writeHead(404).end()
        return
      }
      let received = '', size = 0
      request.on('data', chunk => {
        size += chunk.length
        if (size > 2 * 1024 * 1024) { fakeFailure = 'unbounded_TEST_model_request'; request.destroy() }
        else received += chunk.toString()
      })
      request.on('end', () => {
        try {
          const value = JSON.parse(received)
          if (value.model !== modelID || value.stream !== true)
            throw Error('TEST_unexpected_model_or_nonstream')
          modelCalls++
          const base = { id: 'chatcmpl-TEST-embedded', object: 'chat.completion.chunk',
            model: modelID, created: 1 }
          const chunk = (delta, finish_reason = null) => ({ ...base,
            choices: [{ index: 0, delta, finish_reason }] })
          if (interruptArmed) {
            // Keep only this TEST-owned local response in-flight. The real
            // embedded engine must abort it; the fixture never completes it.
            interruptArmed = false
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            response.write('data: ' + JSON.stringify(chunk({ role: 'assistant' })) + '\n\n')
            interruptStream = response
            notifyInterruptStream?.()
            return
          }
          let toolRequest = false
          if (toolPhase) {
            toolModelRequests++
            // Auxiliary title or summary generations can race the primary turn:
            // never send a tool-call-shaped response without an advertised tool.
            const names = Array.isArray(value.tools) ? value.tools
              .map(tool => tool?.function?.name ?? tool?.name)
              .filter(name => typeof name === 'string')
              .slice(0, 64).map(name => name.slice(0, 80)) : []
            if (toolRequestProfiles.length < 12) toolRequestProfiles.push({
              ordinal: toolModelRequests, tools: names,
              messageCount: Array.isArray(value.messages) ? value.messages.length : null,
              toolChoice: typeof value.tool_choice === 'string' ? value.tool_choice : null,
            })
            if (names.includes('read')) advertisedToolNames = names
            toolRequest = names.includes('read') && !toolCallIssued
            if (toolRequest) toolCallIssued = true
          }
          const frames = (toolRequest ? [
            chunk({ role: 'assistant' }),
            chunk({ tool_calls: [{ index: 0,
              id: toolTargetPath.startsWith(workspace + sep)
                ? 'call_TEST_inside_read' : 'call_TEST_external_read', type: 'function',
              function: { name: 'read', arguments: JSON.stringify(pinnedVersion === '2.1.4'
                ? { filePath: toolTargetPath } : { path: toolTargetPath }) } }] }),
            chunk({}, 'tool_calls'),
          ] : [
            chunk({ role: 'assistant' }), chunk({ content: marker }), chunk({}, 'stop'),
          ]).concat([{ ...base, choices: [], usage: { prompt_tokens: 20,
            completion_tokens: 8, total_tokens: 28 } }]).map(value => 'data: ' + JSON.stringify(value))
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end([...frames, 'data: [DONE]'].join('\n\n') + '\n\n')
        } catch (error) {
          fakeFailure = String(error instanceof Error ? error.message : error)
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end('{"error":"TEST_invalid_fake_model_request"}')
        }
      })
    })
    await new Promise((ok, reject) => fake.once('error', reject).listen(0, '127.0.0.1', ok))
    const address = fake.address()
    if (!address || typeof address === 'string') throw Error('TEST_fake_model_not_loopback')
    options.config.content = JSON.stringify({
      model: providerID + '/' + modelID, providers: {
        [providerID]: { name: 'TEST isolated local model',
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: 'http://127.0.0.1:' + address.port + '/v1',
            apiKey: 'TEST-non-secret' },
          models: { [modelID]: { name: 'TEST local only',
            capabilities: { tools: toolMode, input: ['text'], output: ['text'] },
            limit: { context: 8192, output: 1024 } } },
        },
      },
      // Deny external-path checks without hiding the read tool itself from
      // model discovery. A blanket tool.use deny can prevent tool advertising,
      // leaving a fake-model tool call with no actual native tool invocation.
      // Older V2.0.21 cannot be treated as supporting this policy contract.
      ...(toolMode && pinnedVersion === '2.1.4' ? { policies: [{ action: 'tool.use', resource: 'external_directory:*', effect: 'deny' }] } : {}),
    })
    receipt.steps.push('TEST_embedded_loopback_model_configured')
  }
  host = await OpenCode.create(options)
  const session = await host.sessions.create({ location: { directory: workspace } })
  if (typeof session?.id !== 'string' || !session.id.startsWith('ses_') ||
      session.location?.directory !== workspace)
    throw Error('TEST_embedded_session_binding')
  receipt.steps.push('TEST_embedded_session_created')
  const before = await readLog(host, session.id)
  if (before[0]?.type !== 'session.created' ||
      before[0]?.durable?.aggregateID !== session.id ||
      before[0]?.durable?.seq !== 0 ||
      before.length !== 2)
    throw Error('TEST_embedded_first_durable_event_missing')
  receipt.firstLog = { event: before[0].type, sequence: before[0].durable.seq,
    syncedWatermark: before.at(-1).seq }
  receipt.steps.push('TEST_embedded_durable_event_persisted')
  if (modelMode) {
    // Exercise actual embedded permission APIs, but never run a tool. The
    // separate TEST session owns all asks; a foreign session cannot grant one.
    const policy = await host.sessions.create({ location: { directory: workspace },
      agent: 'build', permissions: [
        // Native V2 is ordered: these intentionally conflicting broad rules
        // must resolve to the *last* matching rule, not to the first/default.
        { action: 'external_directory', resource: '*', effect: 'allow' },
        { action: 'external_directory', resource: '*', effect: 'deny' },
        { action: 'shell', resource: '*', effect: 'deny' },
        { action: 'shell', resource: '*', effect: 'ask' },
      ] })
    const denied = await host.permission.create({ sessionID: policy.id,
      action: 'external_directory', resources: [join(root, 'outside')], agent: 'build' })
    const deniedPending = await host.permission.list({ sessionID: policy.id })
    if (denied?.effect !== 'deny' || !Array.isArray(deniedPending) || deniedPending.length !== 0)
      throw Error('TEST_embedded_policy_external_directory_deny_failed')
    // The reverse ordering must produce ask, not default V2 allow. Keep the
    // request owned by another disposable native session and explicitly reject.
    const askPolicy = await host.sessions.create({ location: { directory: workspace },
      agent: 'build', permissions: [
        { action: 'external_directory', resource: '*', effect: 'deny' },
        { action: 'external_directory', resource: '*', effect: 'ask' },
      ] })
    const externalAsk = await host.permission.create({ sessionID: askPolicy.id,
      action: 'external_directory', resources: [join(root, 'outside-ask')], agent: 'build' })
    const externalPending = await host.permission.list({ sessionID: askPolicy.id })
    if (externalAsk?.effect !== 'ask' || !/^per[A-Za-z0-9_-]+$/.test(externalAsk?.id ?? '') ||
        !Array.isArray(externalPending) || externalPending.length !== 1 ||
        externalPending[0]?.id !== externalAsk.id || externalPending[0]?.sessionID !== askPolicy.id)
      throw Error('TEST_embedded_ordered_external_directory_ask_failed')
    await host.permission.reply({ sessionID: askPolicy.id,
      requestID: externalAsk.id, decision: 'reject' })
    if ((await host.permission.list({ sessionID: askPolicy.id })).length !== 0)
      throw Error('TEST_embedded_ordered_external_ask_not_cleared')
    await host.sessions.remove({ sessionID: askPolicy.id })
    receipt.steps.push('TEST_embedded_ordered_external_deny_and_ask_verified')
    const asked = await host.permission.create({ sessionID: policy.id,
      action: 'shell', resources: ['TEST-no-execution'], agent: 'build' })
    const pending = await host.permission.list({ sessionID: policy.id })
    if (asked?.effect !== 'ask' || !/^per[A-Za-z0-9_-]+$/.test(asked?.id ?? '') ||
        !Array.isArray(pending) || pending.length !== 1 || pending[0]?.id !== asked.id ||
        pending[0]?.sessionID !== policy.id)
      throw Error('TEST_embedded_owned_permission_ask_failed')
    const neighbor = await host.sessions.create({ location: { directory: workspace }, agent: 'build' })
    // The generated SDK throws the declared 404 error by _tag/name; a transport
    // error, missing method or malformed response must NOT count as auth denial.
    const missingPermission = error => error instanceof Error &&
      error.name === 'PermissionNotFoundError' && error.requestID === asked.id
    let foreignRejected = false, staleRejected = false
    try { await host.permission.reply({ sessionID: neighbor.id, requestID: asked.id, decision: 'once' }) }
    catch (error) { foreignRejected = missingPermission(error) }
    if (!foreignRejected || (await host.permission.list({ sessionID: policy.id })).length !== 1)
      throw Error('TEST_embedded_foreign_permission_reply_applied')
    await host.permission.reply({ sessionID: policy.id, requestID: asked.id, decision: 'reject' })
    try { await host.permission.reply({ sessionID: policy.id, requestID: asked.id, decision: 'once' }) }
    catch (error) { staleRejected = missingPermission(error) }
    if (!staleRejected || (await host.permission.list({ sessionID: policy.id })).length !== 0)
      throw Error('TEST_embedded_stale_permission_reply_applied')
    await host.sessions.remove({ sessionID: neighbor.id })
    await host.sessions.remove({ sessionID: policy.id })
    if (modelCalls !== 0 || earlyModelRequests !== 0)
      throw Error('TEST_embedded_permission_discovery_started_model')
    receipt.permissionPolicy = { denied: true, asked: true, rejected: true,
      orderedExternalDirectoryDenyAndAsk: true, orderedShellAsk: true,
      foreignReplyDenied: true, staleReplyDenied: true, modelCalls: 0 }
    receipt.steps.push('TEST_embedded_permission_policy_and_session_isolation_verified')
  }
  await host.close()
  host = undefined
  receipt.steps.push('TEST_embedded_host_closed_before_restart')
  host = await OpenCode.create(options)
  const restored = await host.sessions.get({ sessionID: session.id })
  if (restored?.id !== session.id || restored.location?.directory !== workspace)
    throw Error('TEST_embedded_cold_session_identity')
  const after = await readLog(host, session.id)
  if (after.length !== 2 || after[0]?.id !== before[0]?.id ||
      after[0]?.type !== 'session.created' || after[0]?.durable?.seq !== 0 ||
      after.at(-1)?.seq !== before.at(-1)?.seq)
    throw Error('TEST_embedded_cold_durable_log_mismatch')
  receipt.steps.push('TEST_embedded_durable_log_survived_cold_restart')
  if (modelMode) {
    const modelID = 'TEST-native-model', providerID = 'test-native'
    const marker = 'TEST_V2_EMBEDDED_LOCAL_REPLY'
    let models
    for (let attempt = 0; attempt < 40; attempt++) {
      models = await host.model.list()
      if (Array.isArray(models?.data) && models.data.some(item =>
        item.id === modelID && item.providerID === providerID)) break
      await delay(250)
    }
    if (!Array.isArray(models?.data) || !models.data.some(item =>
      item.id === modelID && item.providerID === providerID))
      throw Error('TEST_embedded_model_selection_not_qualified')
    const original = await host.sessions.create({ location: { directory: workspace },
      agent: 'build', model: { providerID, id: modelID },
      permissions: [{ action: 'external_directory', resource: '*', effect: 'deny' },
        { action: 'shell', resource: '*', effect: 'deny' }] })
    if (earlyModelRequests !== 0 || modelCalls !== 0 || fakeFailure)
      throw Error('TEST_embedded_model_used_before_owner_admission')
    allowInference = true
    const inputID = 'msg_TESTembeddedModelTurn'
    const inputText = 'TEST return the local marker'
    const admitted = await host.sessions.prompt({ sessionID: original.id,
      id: inputID, text: inputText,
      delivery: 'queue', resume: true })
    if (admitted?.id !== inputID || admitted?.sessionID !== original.id ||
        admitted?.type !== 'user')
      throw Error('TEST_embedded_model_prompt_not_admitted')
    receipt.steps.push('TEST_embedded_model_prompt_admitted')
    let terminalLog, transcript
    for (let attempt = 0; attempt < 80; attempt++) {
      terminalLog = await readLog(host, original.id)
      if (terminalLog.some(event => event.type === 'session.execution.succeeded')) break
      await delay(250)
    }
    const events = terminalLog.filter(event => event.type !== 'log.synced')
    const delivered = events.filter(event => event.type === 'session.inbox.delivered' &&
      event.data?.inboxID === inputID)
    const terminals = events.filter(event => event.type === 'session.execution.succeeded')
    const sequence = events.map(event => event?.durable?.seq)
    if (fakeFailure || modelCalls < 1 || delivered.length !== 1 ||
        terminals.length !== 1 || !events.some(event => event.type === 'session.created') ||
        sequence.some((value, index) => !Number.isSafeInteger(value) ||
          (index > 0 && value <= sequence[index - 1])))
      throw Error('TEST_embedded_model_durable_lineage_unqualified')
    transcript = await host.message.list({ sessionID: original.id, limit: 200 })
    const messages = transcript?.data
    const users = Array.isArray(messages) ? messages.filter(row => row.id === inputID && row.type === 'user') : []
    const assistants = Array.isArray(messages) ? messages.filter(row => row.type === 'assistant' &&
      JSON.stringify(row).includes(marker)) : []
    const idleRows = Array.isArray(messages) ? messages.filter(row => row.type === 'idle') : []
    // Pinned v2.0.0 has no SessionMessage.Idle schema; v2.0.21 added it.
    // Neither version may substitute a text reply for a durable terminal.
    const expectedIdleCount = pinnedVersion === '2.0.0' ? 0 : 1
    const state = await host.sessions.get({ sessionID: original.id })
    if (users.length !== 1 || assistants.length !== 1 ||
        idleRows.length !== expectedIdleCount ||
        (expectedIdleCount === 1 && idleRows[0]?.outcome !== 'succeeded') ||
        state?.outcome !== 'succeeded')
      throw Error('TEST_embedded_model_transcript_mismatch')
    // Actual native events and message rows must also pass the private V2
    // driver codec/projector; a fixture-only success is insufficient.
    const codecs = await import('../packages/provider-implementations/src/features/provider-session-implementation/adapters/opencode-protocol/v2-cut-codecs.ts')
    const projection = await import('../packages/provider-implementations/src/features/provider-session-implementation/adapters/opencode-protocol/v2-turn-projection.ts')
    const encodedFrames = terminalLog.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')
    const decodedLog = codecs.decodeV2Log(encodedFrames, original.id, workspace)
    // Use real SDK HTTP pagination metadata, not a synthetic cursor fixture.
    // The V2 API returns next/previous on every nonempty page; consuming the
    // final next cursor must yield an empty page without more cursors.
    const decodedMessages = codecs.decodeV2MessagePage(transcript, original.id)
    if (decodedMessages.data.length !== messages.length ||
        decodedMessages.next === null || decodedMessages.previous === null)
      throw Error('TEST_embedded_native_first_page_cursor_invalid')
    const terminalPage = codecs.decodeV2MessagePage(await host.message.list({
      sessionID: original.id, limit: 200, cursor: decodedMessages.next,
    }), original.id)
    if (terminalPage.data.length !== 0 || terminalPage.next !== null ||
        terminalPage.previous !== null)
      throw Error('TEST_embedded_native_pagination_not_exhausted')
    receipt.steps.push('TEST_embedded_native_message_pagination_verified')
    // Only the private projection contract is being qualified here. The
    // selected runtime/driver backend stays HOLD for 2.1.4 pending its own
    // versioned Host/process and effective-permissions E2E.
    const projected = projection.projectOpenCodeV2NativeTurn({
      pin: pinnedVersion, sessionID: original.id, nativeInputID: inputID,
      originalText: inputText, beforeCursor: 0,
      messages: { data: decodedMessages.data, previous: null, next: null },
      log: decodedLog,
    })
    receipt.driverProjection = { state: projected.state, reason: projected.reason,
      assistantLineage: projected.assistantMessageIds.length,
      backendAdmitted: false }
    if (projected.state !== 'succeeded' || projected.assistantMessageIds.length !== 1 ||
        !projected.text.includes(marker))
      throw Error('TEST_embedded_production_driver_projection_' + projected.reason)
    receipt.steps.push('TEST_embedded_production_driver_projection_verified')
    if (pinnedVersion === '2.1.4')
      receipt.steps.push('TEST_embedded_target_backend_not_admitted')
    receipt.modelTurn = { modelCalls, earlyModelRequests, delivered: 1, terminals: 1,
      loggedEvents: events.length, originalInputBound: true,
      assistantPresent: true, idlePresent: idleRows.length === 1 }
    receipt.steps.push('TEST_embedded_durable_model_terminal_qualified')
    // A committed input ID is scoped to its original session, including on
    // this embedded durable server. A second TEST session cannot adopt it or
    // trigger another model request after the original terminal.
    const foreignSession = await host.sessions.create({ location: { directory: workspace } })
    if (typeof foreignSession?.id !== 'string' || foreignSession.id === original.id)
      throw Error('TEST_embedded_foreign_session_identity')
    const beforeForeignCalls = modelCalls
    let refusedID = false
    try {
      await host.sessions.prompt({ sessionID: foreignSession.id, id: inputID,
        text: 'TEST foreign reuse forbidden', delivery: 'queue', resume: false })
    } catch (error) {
      if (error?._tag !== 'ConflictError' || error?.resource !== inputID)
        throw Error('TEST_embedded_foreign_collision_wrong_failure')
      refusedID = true
    }
    const foreignInbox = await host.sessions.inbox.list({ sessionID: foreignSession.id })
    const foreignMessages = (await host.message.list({
      sessionID: foreignSession.id, limit: 200,
    }))?.data
    if (!refusedID || !Array.isArray(foreignInbox) || foreignInbox.length !== 0 ||
        !Array.isArray(foreignMessages) || foreignMessages.length !== 0 ||
        modelCalls !== beforeForeignCalls)
      throw Error('TEST_embedded_foreign_input_adopted_or_effect')
    await host.sessions.remove({ sessionID: foreignSession.id })
    receipt.crossSessionIdempotency = { conflict: 'ConflictError', foreignInbox: 0,
      foreignMessages: 0, extraModelCalls: 0 }
    receipt.steps.push('TEST_embedded_foreign_input_id_denied_without_model')
    const frozenIDs = events.map(event => event.id)
    const beforeColdCalls = modelCalls
    await host.close()
    host = undefined
    host = await OpenCode.create(options)
    const recovered = await host.sessions.get({ sessionID: original.id })
    const restoredLog = await readLog(host, original.id)
    const replayed = restoredLog.filter(event => event.type !== 'log.synced')
    const restoredMessages = (await host.message.list({ sessionID: original.id, limit: 200 }))?.data
    if (recovered?.id !== original.id || recovered?.outcome !== 'succeeded' ||
        JSON.stringify(replayed.map(event => event.id)) !== JSON.stringify(frozenIDs) ||
        !Array.isArray(restoredMessages) ||
        restoredMessages.filter(row => row.id === inputID && row.type === 'user').length !== 1 ||
        restoredMessages.filter(row => row.type === 'assistant' &&
          JSON.stringify(row).includes(marker)).length !== 1 ||
        modelCalls !== beforeColdCalls)
      throw Error('TEST_embedded_model_cold_lineage_or_no_replay_failed')
    receipt.steps.push('TEST_embedded_model_durable_lineage_survived_cold_restart')
    if (interruptMode) {
      // A real in-flight native model call must be interrupted, not simply
      // pre-cancelled or allowed to complete. Leave the TEST fake model stream
      // pending until the embedded runtime cancels its HTTP request.
      const interrupted = await host.sessions.create({ location: { directory: workspace },
        agent: 'build', model: { providerID: 'test-native', id: 'TEST-native-model' },
        permissions: [{ action: 'shell', resource: '*', effect: 'deny' }] })
      const input = 'msg_TESTinFlightInterrupt'
      let signalStarted
      const started = new Promise(resolve => { signalStarted = resolve })
      notifyInterruptStream = signalStarted
      interruptArmed = true
      const beforeInterruptCalls = modelCalls
      const admitted = await host.sessions.prompt({ sessionID: interrupted.id, id: input,
        text: 'TEST interrupt the pending local stream', delivery: 'queue', resume: true })
      if (admitted?.id !== input || admitted?.sessionID !== interrupted.id)
        throw Error('TEST_active_interrupt_prompt_not_admitted')
      await Promise.race([started, delay(12_000).then(() => { throw Error('TEST_active_interrupt_stream_not_started') })])
      if (!interruptStream || modelCalls !== beforeInterruptCalls + 1)
        throw Error('TEST_active_interrupt_model_not_observed')
      const stopped = await host.sessions.interrupt({ sessionID: interrupted.id, resume: false })
      if (stopped?.interrupted !== true) throw Error('TEST_active_interrupt_receipt_not_true')
      let interruptedLog
      for (let attempt = 0; attempt < 60; attempt++) {
        interruptedLog = await readLog(host, interrupted.id)
        if (interruptedLog.some(e => e.type === 'session.execution.interrupted')) break
        await delay(200)
      }
      const ledger = interruptedLog?.filter(e => e.type !== 'log.synced') ?? []
      const terminal = ledger.filter(e => e.type.startsWith('session.execution.') &&
        ['succeeded', 'failed', 'interrupted'].some(t => e.type.endsWith('.' + t)))
      const delivery = ledger.filter(e => e.type === 'session.inbox.delivered' &&
        e.data?.inboxID === input)
      // A durable terminal may commit just ahead of the HTTP socket close.
      // Wait for the transport-owned stream to settle before judging cleanup.
      for (let attempt = 0; attempt < 30 && !interruptStream.destroyed; attempt++)
        await delay(100)
      receipt.interruptObservations = {
        terminalTypes: terminal.map(e => e.type).slice(0, 8),
        reason: terminal[0]?.data?.reason ?? null, delivered: delivery.length,
        modelRequests: modelCalls - beforeInterruptCalls,
        socketClosed: interruptStream.destroyed,
      }
      if (terminal.length !== 1 || terminal[0].type !== 'session.execution.interrupted' ||
          terminal[0].data?.reason !== 'user' || delivery.length !== 1 ||
          modelCalls !== beforeInterruptCalls + 1 || !interruptStream.destroyed)
        throw Error('TEST_active_interrupt_durable_terminal_or_cancel_unqualified')
      const originalIDs = ledger.map(e => e.id)
      const callsAtInterrupt = modelCalls
      await host.close(); host = undefined
      host = await OpenCode.create(options)
      const restored = await readLog(host, interrupted.id)
      const actualIDs = restored.filter(e => e.type !== 'log.synced').map(e => e.id)
      if (JSON.stringify(actualIDs) !== JSON.stringify(originalIDs) ||
          modelCalls !== callsAtInterrupt ||
          (await host.sessions.get({ sessionID: interrupted.id }))?.id !== interrupted.id)
        throw Error('TEST_active_interrupt_restarted_or_replayed')
      await host.sessions.remove({ sessionID: interrupted.id })
      receipt.nativeInterrupt = { active: true, interrupted: true,
        reason: 'user', delivered: 1, modelRequests: 1, extraAfterRestart: 0,
        streamCancelled: true, durableTerminalCount: 1, qualified: false }
      receipt.steps.push('TEST_embedded_active_interrupt_durable_cold_no_replay')
    }
    if (toolMode) {
      let safeSessionID, safeEventIDs, safeMessageIDs
      // TEST-only: the model requests an outside-workspace read which never
      // opens the canary. V2.0.21 must deny via explicit session rules;
      // V2.1.4 deliberately allows those rules and relies on hard policy.
      writeFileSync(join(root, 'outside-canary.txt'), toolCanary, { mode: 0o600 })
      const toolSession = await host.sessions.create({
        location: { directory: workspace }, agent: 'build',
        model: { providerID: 'test-native', id: 'TEST-native-model' },
        permissions: [
          { action: 'external_directory', resource: '*',
            effect: pinnedVersion === '2.1.4' ? 'allow' : 'deny' },
          { action: 'read', resource: '*', effect: 'allow' },
        ],
      })
      toolPhase = true
      const admittedTool = await host.sessions.prompt({
        sessionID: toolSession.id, id: 'msg_TESTpolicyTool',
        text: 'TEST ask to read the outside canary', delivery: 'queue', resume: true,
      })
      if (admittedTool?.id !== 'msg_TESTpolicyTool')
        throw Error('TEST_policy_tool_prompt_not_admitted')
      let toolLog
      for (let attempt = 0; attempt < 80; attempt++) {
        toolLog = await readLog(host, toolSession.id)
        if (toolLog.some(event => /^session\.execution\.(?:failed|succeeded)$/.test(event.type))) break
        await delay(250)
      }
      const toolPage = await host.message.list({ sessionID: toolSession.id, limit: 200 })
      const toolMessages = toolPage?.data
      const toolHistory = JSON.stringify({ toolLog, toolMessages })
      if (toolModelRequests < 1 || !toolLog?.some(event => /^session\.execution\.(?:failed|succeeded)$/.test(event.type)) ||
          !Array.isArray(toolMessages) || toolHistory.includes(toolCanary))
        throw Error('TEST_policy_tool_not_executed_or_canary_leaked')
      // Record only bounded, non-sensitive result metadata; never persist any
      // native tool arguments, error messages, canary content, or user data.
      const toolOutcomes = toolMessages
        .filter(message => message?.type === 'assistant' && Array.isArray(message.content))
        .flatMap(message => message.content)
        .filter(part => part?.type === 'tool')
        .slice(0, 16)
        .map(part => ({
          name: typeof part.name === 'string' ? part.name.slice(0, 64) : null,
          status: typeof part.state?.status === 'string' ? part.state.status.slice(0, 32) : null,
          errorType: typeof part.state?.error?.type === 'string' ? part.state.error.type.slice(0, 80) : null,
          executed: part.executed === true,
        }))
      // Raw SDK SessionMessage.Assistant.content is top-level. Only the
      // private decoder's OpenCodeV2NativeMessage wrapper uses .data.content.
      // Match the durable failure to this TEST-owned permission evaluation,
      // not to an arbitrary tool/runtime exception or a model terminal.
      const toolEventTypes = toolLog.filter(event => event.type.startsWith('session.tool.'))
        .map(event => event.type).slice(0, 32)
      const toolEventFailures = toolLog.filter(event => event.type === 'session.tool.failed')
        .slice(0, 8).map(event => ({
          errorType: typeof event.data?.error?.type === 'string' ? event.data.error.type.slice(0, 80) : null,
          executed: event.data?.executed === true, toolName: typeof event.data?.name === 'string'
            ? event.data.name.slice(0, 80) : null,
        }))
      const typedDenial = toolOutcomes.length === 1 && toolOutcomes.some(part =>
        part.name === 'read' && part.status === 'error' && part.errorType === 'permission.rejected' &&
        part.executed === false) &&
        toolEventTypes.includes('session.tool.called') &&
        toolEventFailures.length === 1 &&
        toolEventFailures[0].errorType === 'permission.rejected' &&
        toolEventFailures[0].executed === false
      const executorQualified = pinnedVersion === '2.1.4'
        ? toolPermissionRejections.length === 1 &&
          toolPermissionRejections[0].name === 'Tool.Error' &&
          toolPermissionRejections[0].policyDenied === true &&
          toolExecutorCalls === 1 && toolAuthorizedCalls === 0
        : toolPluginSetupCalls === 0 && toolExecutorCalls === 0 &&
          toolAuthorizedCalls === 0 && toolPermissionRejections.length === 0
      const toolEffectObserved = typedDenial && executorQualified
      const assistantPartTypes = [...new Set(toolMessages
        .filter(message => message?.type === 'assistant' && Array.isArray(message.content))
        .flatMap(message => message.content)
        .map(part => part?.type)
        .filter(type => typeof type === 'string'))].slice(0, 16)
      const advertisedReadTool = advertisedToolNames.includes('read')
      receipt.toolPolicyDiscovery = {
        attemptedModelTool: true,
        enforcementSource: pinnedVersion === '2.1.4' ? 'hard-config-policy' : 'session-explicit-deny',
        modelRequests: toolModelRequests,
        advertisedReadTool, advertisedToolNames, toolRequestProfiles, toolCallIssued,
        assistantPartTypes, toolOutcomes,
        toolEventTypes, toolEventFailures, toolPluginSetupCalls, toolRegisteredNames,
        toolContextCalls, toolContextNames, toolExecutorCalls, toolAuthorizedCalls,
        toolPermissionRejections, toolEffectObserved, policyDenialUnverified: !toolEffectObserved,
        terminal: toolLog.filter(event => /^session\.execution\.(?:failed|succeeded)$/.test(event.type)).map(event => event.type),
        canaryLeak: false, qualified: false,
      }
      if (!toolEffectObserved) throw Error('TEST_embedded_effective_tool_policy_denial_unverified')
      const toolCut = {
        pin: pinnedVersion, sessionID: toolSession.id, nativeInputID: 'msg_TESTpolicyTool',
        originalText: 'TEST ask to read the outside canary', beforeCursor: 0,
        messages: { data: codecs.decodeV2MessagePage(toolPage, toolSession.id).data,
          previous: null, next: null },
        log: codecs.decodeV2Log(toolLog.map(item => 'data: ' + JSON.stringify(item) + '\n\n').join(''),
          toolSession.id, workspace),
      }
      const toolProjection = projection.projectOpenCodeV2NativeTurn(toolCut)
      receipt.toolPolicyDiscovery.driverProjection = {
        state: toolProjection.state, reason: toolProjection.reason,
        tools: toolProjection.tools.map(tool => ({ name: tool.toolName,
          status: tool.status, executed: tool.executed })).slice(0, 8),
      }
      if (toolProjection.state !== 'succeeded' ||
          toolProjection.tools.length !== 1 ||
          toolProjection.tools[0]?.toolName !== 'read' ||
          toolProjection.tools[0]?.status !== 'error' ||
          toolProjection.tools[0]?.executed !== false)
        throw Error('TEST_embedded_denied_tool_production_projection_mismatch')
      receipt.steps.push('TEST_embedded_effective_tool_policy_denial_verified')
      receipt.steps.push('TEST_embedded_denied_tool_production_projection_verified')
      const deniedEventIDs = toolLog.filter(item => typeof item.id === 'string').map(item => item.id)
      const deniedMessageIDs = toolMessages.map(item => item.id).sort()
      toolPhase = false
      if (pinnedVersion === '2.0.21') {
        // Positive control with the official built-in read. The same TEST
        // engine must admit an in-project file while the earlier outside file
        // was denied. No plugin, user path, external network or real model.
        const insideMarker = 'TEST_NATIVE_ALLOWED_WORKSPACE_READ'
        toolTargetPath = join(workspace, 'read-control.txt')
        writeFileSync(toolTargetPath, insideMarker, { mode: 0o600 })
        toolCallIssued = false; toolModelRequests = 0
        advertisedToolNames = []; toolRequestProfiles = []; toolPhase = true
        const callsBefore = modelCalls
        const allowedSession = await host.sessions.create({
          location: { directory: workspace }, agent: 'build',
          model: { providerID: 'test-native', id: 'TEST-native-model' },
          permissions: [
            { action: 'external_directory', resource: '*', effect: 'deny' },
            { action: 'read', resource: '*', effect: 'allow' },
          ],
        })
        const insideInputID = 'msg_TESTinsideRead'
        const insideAdmission = await host.sessions.prompt({
          sessionID: allowedSession.id, id: insideInputID,
          text: 'TEST read a harmless file inside the current workspace',
          delivery: 'queue', resume: true,
        })
        if (insideAdmission?.id !== insideInputID)
          throw Error('TEST_embedded_inside_read_prompt_not_admitted')
        let insideLog
        for (let attempt = 0; attempt < 80; attempt++) {
          insideLog = await readLog(host, allowedSession.id)
          if (insideLog.some(event => /^session\.execution\.(?:failed|succeeded)$/.test(event.type))) break
          await delay(250)
        }
        const insidePage = await host.message.list({ sessionID: allowedSession.id, limit: 200 })
        const insideMessages = insidePage?.data
        const safeParts = Array.isArray(insideMessages) ? insideMessages
          .filter(message => message?.type === 'assistant' && Array.isArray(message.content))
          .flatMap(message => message.content).filter(part => part?.type === 'tool') : []
        const success = insideLog?.filter(event => event.type === 'session.tool.success') ?? []
        const failures = insideLog?.filter(event => event.type === 'session.tool.failed') ?? []
        const safeReadResult = safeParts.filter(part => part.name === 'read' &&
          part.state?.status === 'completed' &&
          JSON.stringify(part.state).includes(insideMarker))
        receipt.safeReadControl = { nativeToolSuccess: success.length,
          nativeToolFailed: failures.length, completedSnapshots: safeReadResult.length,
          sessionOwned: insideAdmission?.sessionID === allowedSession.id,
          canaryLeak: JSON.stringify(insideMessages).includes(toolCanary),
          newModelCalls: modelCalls - callsBefore, qualified: false }
        if (success.length !== 1 || failures.length !== 0 || safeReadResult.length !== 1 ||
            insideAdmission?.sessionID !== allowedSession.id ||
            receipt.safeReadControl.canaryLeak || modelCalls <= callsBefore ||
            !insideLog.some(event => event.type === 'session.execution.succeeded'))
          throw Error('TEST_embedded_in_workspace_positive_tool_control_failed')
        const insideCut = {
          pin: pinnedVersion, sessionID: allowedSession.id, nativeInputID: insideInputID,
          originalText: 'TEST read a harmless file inside the current workspace', beforeCursor: 0,
          messages: { data: codecs.decodeV2MessagePage(insidePage, allowedSession.id).data,
            previous: null, next: null },
          log: codecs.decodeV2Log(insideLog.map(item => 'data: ' + JSON.stringify(item) + '\n\n').join(''),
            allowedSession.id, workspace),
        }
        const safeProjection = projection.projectOpenCodeV2NativeTurn(insideCut)
        receipt.safeReadControl.driverProjection = {
          state: safeProjection.state,
          tools: safeProjection.tools.map(tool => ({ name: tool.toolName,
            status: tool.status, executed: tool.executed })).slice(0, 8),
        }
        if (safeProjection.state !== 'succeeded' || safeProjection.tools.length !== 1 ||
            safeProjection.tools[0]?.toolName !== 'read' ||
            safeProjection.tools[0]?.status !== 'completed')
          throw Error('TEST_embedded_allowed_tool_production_projection_mismatch')
        receipt.steps.push('TEST_embedded_builtin_read_inside_workspace_succeeded')
        receipt.steps.push('TEST_embedded_allowed_tool_production_projection_verified')
        safeSessionID = allowedSession.id
        safeEventIDs = insideLog.filter(item => typeof item.id === 'string').map(item => item.id)
        safeMessageIDs = insideMessages.map(item => item.id).sort()
        toolPhase = false
      }
      // A completed permission-denied tool must never execute again when the
      // embedded host reopens the exact same durable state. Preserve both
      // ledger IDs and projected message IDs across this TEST-only restart.
      const callsBeforeToolRestart = modelCalls
      await host.close(); host = undefined
      host = await OpenCode.create(options)
      const stable = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)
      const deniedAfter = await readLog(host, toolSession.id)
      const deniedAfterMessages = (await host.message.list({ sessionID: toolSession.id, limit: 200 })).data
      if (!stable(deniedAfter.filter(e => typeof e.id === 'string').map(e => e.id), deniedEventIDs) ||
          !stable(deniedAfterMessages.map(e => e.id).sort(), deniedMessageIDs) ||
          (await host.sessions.get({ sessionID: toolSession.id }))?.id !== toolSession.id)
        throw Error('TEST_embedded_denied_tool_cold_lineage_mismatch')
      if (safeSessionID) {
        const safeAfter = await readLog(host, safeSessionID)
        const safeAfterMessages = (await host.message.list({ sessionID: safeSessionID, limit: 200 })).data
        if (!stable(safeAfter.filter(e => typeof e.id === 'string').map(e => e.id), safeEventIDs) ||
            !stable(safeAfterMessages.map(e => e.id).sort(), safeMessageIDs) ||
            (await host.sessions.get({ sessionID: safeSessionID }))?.id !== safeSessionID)
          throw Error('TEST_embedded_allowed_tool_cold_lineage_mismatch')
        await host.sessions.remove({ sessionID: safeSessionID })
      }
      if (modelCalls !== callsBeforeToolRestart)
        throw Error('TEST_embedded_tool_replayed_after_cold_restart')
      receipt.toolColdRecovery = { deniedLedgerPreserved: true,
        allowedLedgerPreserved: !!safeSessionID, extraModelCalls: 0, cleanupPending: false }
      await host.sessions.remove({ sessionID: toolSession.id })
      receipt.steps.push('TEST_embedded_tool_lineage_persisted_without_cold_replay')
    }
    await host.sessions.remove({ sessionID: original.id })
  }
  await host.sessions.remove({ sessionID: session.id })
  receipt.steps.push('TEST_embedded_session_removed')
} catch (error) {
  failed = true
  receipt.failure = String(error instanceof Error ? error.message : error)
} finally {
  if (host) {
    try { await host.close() } catch (error) {
      failed = true; receipt.hostCleanupFailure = String(error)
    }
  }
  if (fake) {
    try {
      fake.closeAllConnections()
      await new Promise((ok, reject) => fake.close(error => error ? reject(error) : ok()))
    } catch (error) { failed = true; receipt.fakeCleanupFailure = String(error) }
  }
  try { rmSync(root, { recursive: true, force: true }) } catch (error) {
    failed = true; receipt.testDirectoryCleanupFailure = String(error)
  }
  receipt.cleanup = !receipt.hostCleanupFailure && !receipt.fakeCleanupFailure && !receipt.testDirectoryCleanupFailure
  receipt.completed = !failed && receipt.cleanup
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ completed: receipt.completed, steps: receipt.steps,
    failure: receipt.failure, cleanup: receipt.cleanup }))
}
if (!receipt.completed) process.exitCode = 1
