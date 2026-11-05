// TEST-only proof of pinned OpenCode V2 embedded durable event retention.
// No native CLI, user credentials, external provider or production activation.
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const receiptPath = resolve(process.env.OPENCODE_V2_EMBEDDED_RECEIPT || 'native-v2-embedded-proof.json')
const prefix = process.env.OPENCODE_V2_EMBEDDED_NPM_PREFIX
const modelMode = process.env.OPENCODE_V2_EMBEDDED_MODEL_PROOF === '1'
const receipt = { kind: 'TEST_V2_EMBEDDED_DURABLE_DISCOVERY_ONLY', qualified: false, steps: [], cleanup: false }
const root = mkdtempSync(join(tmpdir(), 'TEST-v2-embedded-'))
for (const dir of ['workspace', 'home', 'config', 'cache', 'data', 'state', 'temp']) {
  mkdirSync(join(root, dir), { recursive: true })
}
const workspace = join(root, 'workspace'), database = join(root, 'data', 'embedded.sqlite')
let host, fake
let modelCalls = 0, fakeFailure = null, allowInference = false, earlyModelRequests = 0
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
})
const options = {
  app: { name: 'TEST-embedded-native-v2', version: '2.0.21' },
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
  if (typeof prefix !== 'string' || !isAbsolute(prefix)) throw Error('TEST_embedded_prefix_not_absolute')
  const packageRoot = realpathSync(join(prefix, 'node_modules', '@opencode', 'sdk'))
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== '@opencode/sdk' || manifest.version !== '2.0.21')
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
  receipt.steps.push('pinned_embedded_SDK_module_resolved')
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
          const frames = [
            chunk({ role: 'assistant' }), chunk({ content: marker }), chunk({}, 'stop'),
            { ...base, choices: [], usage: { prompt_tokens: 20,
              completion_tokens: 8, total_tokens: 28 } },
          ].map(value => 'data: ' + JSON.stringify(value))
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
            capabilities: { tools: false, input: ['text'], output: ['text'] },
            limit: { context: 8192, output: 1024 } } },
        },
      },
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
    const idle = Array.isArray(messages) ? messages.filter(row => row.type === 'idle' &&
      row.outcome === 'succeeded') : []
    const state = await host.sessions.get({ sessionID: original.id })
    if (users.length !== 1 || assistants.length !== 1 || idle.length !== 1 ||
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
    const projected = projection.projectOpenCodeV2NativeTurn({
      pin: '2.0.21', sessionID: original.id, nativeInputID: inputID,
      originalText: inputText, beforeCursor: 0,
      messages: { data: decodedMessages.data, previous: null, next: null },
      log: decodedLog,
    })
    receipt.driverProjection = { state: projected.state, reason: projected.reason,
      assistantLineage: projected.assistantMessageIds.length }
    if (projected.state !== 'succeeded' || projected.assistantMessageIds.length !== 1 ||
        !projected.text.includes(marker))
      throw Error('TEST_embedded_production_driver_projection_' + projected.reason)
    receipt.steps.push('TEST_embedded_production_driver_projection_verified')
    receipt.modelTurn = { modelCalls, earlyModelRequests, delivered: 1, terminals: 1,
      loggedEvents: events.length, originalInputBound: true,
      assistantPresent: true, idlePresent: true }
    receipt.steps.push('TEST_embedded_durable_model_terminal_qualified')
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
