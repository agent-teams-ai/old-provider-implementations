// Exact 2.1.4 native HTTP + persistent events through the public Session SPI.
// Disposable TEST engine only; product Host/process custody and Desktop are separate gates.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const prefix = process.env.OPENCODE_V2_EMBEDDED_NPM_PREFIX
const expectedPlatform = process.env.OPENCODE_V2_TEST_EXPECTED_PLATFORM
const editCapturePath = process.env.OPENCODE_V2_TEST_EDIT_CAPTURE
const receiptPath = resolve(process.env.OPENCODE_V2_SPI_RECEIPT || 'native-v2-embedded-target-spi-proof.json')
const receipt = { kind: 'TEST_V2_NATIVE_SESSION_SPI', version: '2.1.4', qualified: false,
  completed: false, cleanup: false, steps: [] }
const originalDirectory = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'TEST-v2-spi-'))
for (const name of ['workspace', 'home', 'config', 'cache', 'data', 'state', 'temp']) mkdirSync(join(root, name))
const workspace = join(root, 'workspace'), effectPath = join(workspace, 'effect.txt')
const editPath = join(workspace, 'dirty.txt')
const editBefore = 'TEST clean anchor\nTEST existing dirty\nTEST unchanged tail\n'
const editAfter = 'TEST clean anchor\nTEST native authored\nTEST unchanged tail\n'
writeFileSync(editPath, editBefore, { flag: 'wx', mode: 0o600 })
// Native global read routes may select process.cwd(); it must be the same
// disposable workspace, never the provider checkout or a user's project.
process.chdir(workspace)
const safePath = process.env.PATH ?? process.env.Path ?? ''
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
for (const key of Object.keys(process.env)) if (!['LANG', 'TZ'].includes(key)) delete process.env[key]
Object.assign(process.env, { PATH: safePath, HOME: join(root, 'home'),
  NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
  TMPDIR: join(root, 'temp'), OPENCODE_DISABLE_MODELS_FETCH: 'true', CI: 'true', NO_COLOR: '1',
  ...(process.platform === 'win32' ? {
    ...(typeof systemRoot === 'string' && win32.isAbsolute(systemRoot) ? { SystemRoot: systemRoot } : {}),
    USERPROFILE: join(root, 'home'), APPDATA: join(root, 'config'), LOCALAPPDATA: join(root, 'data'),
    TMP: join(root, 'temp'), TEMP: join(root, 'temp'),
  } : {}),
})
const check = (value, label) => { if (!value) throw Error('TEST_SPI_' + label) }
const until = async (predicate, label) => {
  const end = Date.now() + 25_000
  while (!predicate()) { check(Date.now() < end, label); await delay(20) }
}
const listen = server => new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok))
const endpoint = server => {
  const address = server.address(); check(address && typeof address === 'object', 'listener_missing')
  return 'http://127.0.0.1:' + address.port
}
const stopServer = async server => {
  if (!server?.listening) return
  server.closeAllConnections()
  await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()))
}
const readJSON = async request => {
  const chunks = []; let bytes = 0
  for await (const part of request) {
    bytes += part.length; check(bytes <= 2 * 1024 * 1024 && chunks.length < 4096, 'fixture_request_budget')
    chunks.push(part)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const marker = 'TEST_NATIVE_SPI_INSTRUCTIONS_EFFECTIVE'
const outputMarker = 'TEST_NATIVE_SPI_REPLY'
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII='
const pngBytes = Buffer.from(pngBase64, 'base64'), pngURI = 'data:image/png;base64,' + pngBase64
const pngReference = { artifactId: 'TEST-native-PNG', mimeType: 'image/png', byteLength: pngBytes.length,
  digest: createHash('sha256').update(pngBytes).digest('hex') }
let model, mcp, native, owner, driver, observer
let modelCalls = 0, mcpCalls = 0, fixtureFailure, streamOpen = false, streamClosed = false
let pngResolutions = 0, pngInference = false, pngColdHistory = false
let instructionsSeen = false, catalogSeen = false, allowInference = false
const calledPhases = new Set(), events = []
const captureRequests = []
let capturedBefore, capturedAfter
let phase = 'boot', failed = false, lastNativeStatus
const toolName = 'testteams_TEST_touch'
let stopNative = async () => {}
try {
  check(expectedPlatform === `${process.platform}-${process.arch}`, 'platform_mismatch')
  check(typeof prefix === 'string' && isAbsolute(prefix), 'prefix_missing')
  const modules = realpathSync(join(prefix, 'node_modules'))
  for (const name of ['sdk', 'server', 'core', 'protocol', 'schema']) {
    const manifest = JSON.parse(readFileSync(join(modules, '@opencode', name, 'package.json'), 'utf8'))
    check(manifest.name === '@opencode/' + name && manifest.version === '2.1.4', 'native_graph_identity')
  }
  const serverRoot = realpathSync(join(modules, '@opencode', 'server'))
  const serverEntry = realpathSync(join(serverRoot, 'dist', 'process.js'))
  check(serverEntry.startsWith(serverRoot + sep), 'native_export_escape')
  const effectEntry = realpathSync(createRequire(join(serverRoot, 'package.json')).resolve('effect'))
  check(effectEntry.startsWith(modules + sep), 'effect_export_escape')
  phase = 'provider_import'
  const { createOpenCodeV2DriverFactory, createOpenCodeV2OwnedSessionClient,
    readOpenCodeV2CheckpointSessionId } = await import('../packages/provider-implementations/dist/opencode.js')
  phase = 'native_import'
  const { Effect, Scope, Exit } = await import(pathToFileURL(effectEntry).href)
  const { start } = await import(pathToFileURL(serverEntry).href)
  phase = 'boot'
  mcp = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') { response.writeHead(405).end(); return }
      check(request.method === 'POST' && request.url === '/mcp', 'mcp_route')
      const value = await readJSON(request)
      if (value.id === undefined) { response.writeHead(202).end(); return }
      let result
      if (value.method === 'initialize') result = { protocolVersion: '2025-11-25',
        capabilities: { tools: {} }, serverInfo: { name: 'TEST-native-spi-mcp', version: '0.0.1' } }
      else if (value.method === 'tools/list') result = { tools: [{ name: 'TEST_touch',
        description: 'TEST controlled file effect within the disposable workspace',
        inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } }] }
      else if (value.method === 'tools/call') {
        check(value.params?.name === 'TEST_touch' && value.params?.arguments?.marker === 'TEST_ONCE', 'mcp_call_identity')
        check(phase === 'allow' && mcpCalls === 0, 'mcp_ungranted_or_repeated_effect')
        mcpCalls++; writeFileSync(effectPath, 'TEST_ONCE', { flag: 'wx', mode: 0o600 })
        result = { content: [{ type: 'text', text: 'TEST_MCP_EFFECT_CONFIRMED' }] }
      } else if (value.method === 'ping') result = {}
      else { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'TEST_unsupported' } })); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }))
    } catch { fixtureFailure = 'mcp_fixture'; response.writeHead(400).end() }
  })
  model = createServer(async (request, response) => {
    try {
      check(allowInference && request.method === 'POST' && request.url === '/v1/chat/completions', 'model_route_or_early_request')
      const value = await readJSON(request); modelCalls++
      check(value.model === 'TEST-model' && value.stream === true, 'model_binding')
      const messages = Array.isArray(value.messages) ? value.messages : []
      const lastUser = messages.filter(row => row.role === 'user').at(-1)
      const targeted = JSON.stringify(lastUser ?? {}).includes('TEST native SPI')
      const imageParts = messages.flatMap(row => Array.isArray(row.content) ? row.content : [])
        .filter(part => part.type === 'image_url')
      if (targeted && ['image', 'resumed'].includes(phase)) {
        check(imageParts.length === 1 && imageParts[0].image_url?.url === pngURI, 'native_PNG_model_bytes')
        const currentImages = (Array.isArray(lastUser?.content) ? lastUser.content : []).filter(part => part.type === 'image_url')
        check(currentImages.length === (phase === 'image' ? 1 : 0), 'native_PNG_current_or_history')
        if (phase === 'image') pngInference = true
        else pngColdHistory = true
      }
      const names = (value.tools ?? []).map(tool => tool?.function?.name).filter(name => typeof name === 'string')
      const base = { id: 'chatcmpl_TEST_' + modelCalls, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'TEST-model' }
      const chunk = (delta, finish_reason = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] })
      if (targeted && names.length > 0) {
        instructionsSeen ||= JSON.stringify(messages).includes(marker)
        catalogSeen ||= names.includes(toolName)
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (targeted && phase === 'interrupt') {
        streamOpen = true
        response.on('close', () => { streamClosed = true })
        response.write('data: ' + JSON.stringify(chunk({ role: 'assistant' })) + '\n\n')
        return
      }
      const selectedTool = phase === 'edit' ? 'edit' : toolName
      if (targeted && phase === 'edit') check(names.includes('edit'), 'native_edit_not_offered')
      const invoke = targeted && names.includes(selectedTool) && ['deny', 'allow', 'edit'].includes(phase) && !calledPhases.has(phase)
      if (invoke) calledPhases.add(phase)
      const argumentsText = phase === 'edit'
        ? JSON.stringify({ path: editPath, oldString: 'TEST existing dirty', newString: 'TEST native authored' })
        : '{"marker":"TEST_ONCE"}'
      const frames = invoke ? [chunk({ role: 'assistant' }), chunk({ tool_calls: [{ index: 0,
        id: 'call_TEST_' + phase, type: 'function', function: { name: selectedTool, arguments: argumentsText } }] }),
      chunk({}, 'tool_calls')] : [chunk({ role: 'assistant' }), chunk({ content: outputMarker }), chunk({}, 'stop')]
      frames.push({ ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })
      response.end(frames.map(row => 'data: ' + JSON.stringify(row)).concat('data: [DONE]').join('\n\n') + '\n\n')
    } catch { fixtureFailure = 'model_fixture'; response.destroy() }
  })
  await listen(mcp); await listen(model)
  const options = { hostname: '127.0.0.1', port: 0, password: 'TEST-native-private',
    app: { name: 'TEST-native-session-spi', version: '2.1.4' },
    database: { path: join(root, 'data', 'native.sqlite') }, events: { persist: true },
    models: { fetch: false, snapshot: false }, fs: { filewatcher: false, fff: false },
    config: { directory: join(root, 'config'), project: false, content: JSON.stringify({
      model: 'test-native/TEST-model', providers: { 'test-native': {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: endpoint(model) + '/v1', apiKey: 'TEST-non-secret' },
        models: { 'TEST-model': { capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
          limit: { context: 8192, output: 1024 } } },
      } }, mcp: { servers: { testteams: { type: 'remote', url: endpoint(mcp) + '/mcp', oauth: false, codemode: false, protocol: 'legacy' } } },
      policies: [{ action: 'tool.use', resource: 'external_directory:*', effect: 'deny' }],
    }) },
  }
  let running = false
  const startNative = async () => {
    const scope = await Effect.runPromise(Scope.make())
    let closed = false
    stopNative = async () => {
      if (closed) return
      closed = true
      await Effect.runPromise(Scope.close(scope, Exit.void))
      running = false
    }
    native = await Effect.runPromise(start(options).pipe(Effect.provideService(Scope.Scope, scope)))
    check(native.address?._tag === 'InetAddressV4', 'native_address')
    check(Number.isSafeInteger(native.address.port) && native.address.port > 0, 'native_port')
    running = true
    return 'http://127.0.0.1:' + native.address.port
  }
  const firstEndpoint = await startNative()
  const selection = { agent: 'build', model: { providerID: 'test-native', id: 'TEST-model', variant: 'default' }, permissions: [
    { action: '*', resource: '*', effect: 'deny' }, { action: toolName, resource: '*', effect: 'ask' },
    { action: 'edit', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: '*', effect: 'deny' },
  ] }
  const transportConfig = selectedEndpoint => ({ endpoint: selectedEndpoint, version: '2.1.4', directory: workspace,
    nativeSessionId: 'ses_TESTnativeSPI', deadline: Date.now() + 60_000, readPassword: () => 'TEST-native-private',
    fetchImpl: async (input, init) => {
      try { const response = await fetch(input, init); lastNativeStatus = response.status; return response }
      catch (error) {
        const code = error?.cause?.code ?? error?.code
        if (['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL', 'ABORT_ERR'].includes(code)) receipt.nativeConnection = code
        throw error
      }
    },
  })
  owner = createOpenCodeV2OwnedSessionClient(transportConfig(firstEndpoint))
  phase = 'owner_identity'
  check((await owner.identity()).pid === process.pid, 'native_pid')
  phase = 'owner_create'
  const created = await owner.createSession(selection)
  check(created.id === 'ses_TESTnativeSPI', 'created_identity')
  phase = 'owner_instructions'
  await owner.putInstruction('test-native-spi', marker)
  check((await owner.instructions()).some(row => row.key === 'test-native-spi' && row.value === marker), 'instruction_readback')
  phase = 'owner_saved'
  check(await owner.savedPermissionsEmpty(), 'preexisting_saved_grants')
  phase = 'owner_plugins'
  check(await owner.builtinPluginsOnly(), 'non_builtin_or_failed_plugins')
  phase = 'owner_catalog'
  const catalogDeadline = Date.now() + 25_000
  let catalog = await owner.readCatalog('test-native')
  while ((!catalog.provider || !catalog.defaultModel || !catalog.models.some(row => row.id === 'TEST-model')) && Date.now() < catalogDeadline) {
    await delay(50)
    catalog = await owner.readCatalog('test-native')
  }
  check(catalog.provider?.id === 'test-native' && catalog.provider.activation !== 'disabled', 'catalog_provider')
  check(catalog.defaultModel?.providerId === 'test-native' && catalog.defaultModel.modelId === 'TEST-model', 'catalog_default')
  check(catalog.models.some(row => row.id === 'TEST-model' && row.enabled && row.inputModalities.includes('text')
    && row.inputModalities.includes('image')), 'catalog_model')
  phase = 'owner_mcp'
  let mcpReady = false
  for (let attempt = 0; attempt < 100 && !mcpReady; attempt++) {
    const rows = await owner.readMcp()
    mcpReady = rows.length === 1 && rows[0].name === 'testteams' && rows[0].status === 'connected'
    if (!mcpReady) await delay(50)
  }
  check(mcpReady, 'native_mcp_catalog')
  // Native 2.1.4 debounces MCP registry reload by 100ms after connected.
  // This is only fixture settling; the actual model catalog and native call
  // below still have to prove availability and permission enforcement.
  await delay(200)
  receipt.steps.push('native_owned_identity_model_permissions_instructions_mcp_readback')
  let checkpoint
  const binding = { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-runtime', generation: 1 }
  const driverConfig = selectedEndpoint => ({ ...transportConfig(selectedEndpoint), binding,
    trustedBinding: 'TEST-stable-owned-2.1.4-engine-graph', accountBinding: 'TEST-loopback-only', configRevision: 'TEST-r1',
    limits: { queuedInputs: 2, inputBytes: 4096, outputBytes: 1024 * 1024, outputEvents: 2048,
      pendingInteractions: 4, timeoutMs: 30_000 },
    probe: async () => running && (await owner.identity()).pid === process.pid,
    confirmStopped: async () => { await stopNative(); return !running },
    attachments: { model: 'test-native/TEST-model', revision: 'TEST-PNG-policy-v1', mimeTypes: ['image/png'],
      async resolve(request, signal) {
        signal.throwIfAborted()
        check(request.trustedBinding === 'TEST-stable-owned-2.1.4-engine-graph'
          && request.sessionRef === binding.sessionId && request.inputId === 'TEST-image'
          && request.operationRef === 'TEST-op-image' && JSON.stringify(request.reference) === JSON.stringify(pngReference), 'native_PNG_binding')
        const expected = createHash('sha256').update(JSON.stringify(['TEST native SPI image',
          [[pngReference.artifactId, pngReference.mimeType, pngReference.byteLength, pngReference.digest]]])).digest('hex')
        check(request.fingerprint === expected && pngResolutions === 0, 'native_PNG_original_input')
        pngResolutions++
        return { binding: request, bytes: pngBytes }
      },
    },
    capture: { observe(value) {
      if (value.inputId !== 'TEST-edit') return
      captureRequests.push(value)
      if (value.phase === 'before') capturedBefore = readFileSync(editPath, 'utf8')
      if (value.phase === 'after') capturedAfter = readFileSync(editPath, 'utf8')
    } },
  })
  const factory = selectedEndpoint => createOpenCodeV2DriverFactory({ capabilities: ['text', 'tools', 'permission', 'interrupt', 'checkpoint', 'attachments'],
    resolveConfiguration: async () => driverConfig(selectedEndpoint), readCheckpoint: async () => checkpoint })
  const request = () => ({ ...binding, configRevision: 'TEST-r1', requiredCapabilities: ['text', 'tools', 'permission', 'interrupt', 'checkpoint', 'attachments'] })
  const observe = () => { observer = (async () => { for await (const event of driver.observe()) events.push(event) })() }
  driver = (await factory(firstEndpoint).open(request())).driver; observe(); allowInference = true
  const runInput = async inputPhase => {
    phase = inputPhase
    const reply = await driver.submit({ inputId: 'TEST-' + phase, operationRef: 'TEST-op-' + phase, content: 'TEST native SPI ' + phase,
      ...(phase === 'image' ? { attachments: [pngReference] } : {}) })
    check(reply.ok, 'submit_' + phase)
  }
  const interactionFor = current => events.find(event => event.kind === 'interaction' && event.inputId === 'TEST-' + current)
  const resultFor = current => events.find(event => event.kind === 'result' && event.inputId === 'TEST-' + current)
  for (const current of ['deny', 'allow']) {
    await runInput(current)
    await until(() => interactionFor(current) || resultFor(current) || fixtureFailure, 'permission_missing_' + current)
    check(interactionFor(current) && !fixtureFailure && mcpCalls === 0, 'ungranted_effect_' + current)
    const interaction = interactionFor(current)
    check((await driver.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: current })).ok, 'permission_reply_' + current)
    check(!(await driver.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: current })).ok, 'permission_duplicate_' + current)
    await until(() => resultFor(current) || fixtureFailure, 'terminal_missing_' + current)
    check(resultFor(current)?.outcome === (current === 'deny' ? 'cancelled' : 'succeeded') && !fixtureFailure, 'terminal_' + current)
    check(mcpCalls === (current === 'allow' ? 1 : 0), 'effect_count_' + current)
  }
  check(instructionsSeen && catalogSeen, 'effective_context_or_catalog_missing')
  check(readFileSync(effectPath, 'utf8') === 'TEST_ONCE', 'actual_file_effect')
  receipt.steps.push('session_SPI_native_model_tool_permission_deny_then_once_actual_MCP_effect')
  await runInput('edit')
  await until(() => resultFor('edit') || fixtureFailure, 'native_edit_terminal_missing')
  check(resultFor('edit')?.outcome === 'succeeded' && !fixtureFailure, 'native_edit_terminal')
  check(capturedBefore === editBefore && capturedAfter === editAfter && readFileSync(editPath, 'utf8') === editAfter, 'native_edit_before_after')
  check(captureRequests.length === 2 && captureRequests[0].phase === 'before' && captureRequests[1].phase === 'after', 'native_edit_capture_order')
  const window = captureRequests[1], item = window.items?.[0]
  check(window.dialect === 'v2' && window.beforeObserved && window.gapReason === undefined && window.outcome === 'succeeded', 'native_edit_capture_window')
  check(window.windowRef === captureRequests[0].windowRef && window.nativeSessionId === created.id && window.items.length === 1, 'native_edit_capture_identity')
  check(item?.dialect === 'v2' && item.protocolRevision === '2.1.4' && item.tool === 'edit'
    && item.status === 'completed' && item.providerExecuted === false && item.input?.path === editPath, 'native_edit_capture_tool')
  check(typeof item.calledEvent?.id === 'string' && typeof item.completedEvent?.id === 'string'
    && item.calledEvent.id !== item.completedEvent.id && item.calledEvent.seq < item.completedEvent.seq
    && item.completedEvent.type === 'session.tool.success' && !Object.hasOwn(item, 'partId'), 'native_edit_capture_log_anchors')
  check(Object.isFrozen(window) && Object.isFrozen(item) && Object.isFrozen(item.metadata), 'native_edit_capture_immutable')
  const file = item.metadata?.files?.[0]
  check(Array.isArray(item.metadata?.files) && item.metadata.files.length === 1 && resolve(workspace, file?.file ?? '') === editPath
    && file.status === 'modified' && file.additions === 1 && file.deletions === 1
    && typeof file.patch === 'string' && file.patch.includes('-TEST existing dirty\n+TEST native authored'), 'native_edit_capture_patch')
  receipt.nativeEditCapture = { dialect: 'v2', protocolRevision: '2.1.4', immutable: true,
    beforeSha256: createHash('sha256').update(capturedBefore).digest('hex'),
    afterSha256: createHash('sha256').update(capturedAfter).digest('hex'),
    patchSha256: createHash('sha256').update(file.patch).digest('hex'),
    calledEvent: item.calledEvent, completedEvent: item.completedEvent,
    filePathFlavor: isAbsolute(file.file) ? 'absolute' : 'workspace-relative',
    unifiedIndexEnvelope: file.patch.startsWith('Index: ') && file.patch.includes('\n--- ') && file.patch.includes('\n+++ ') }
  if (editCapturePath !== undefined) {
    check(isAbsolute(editCapturePath), 'edit_capture_path_not_absolute')
    // Optional local TEST evidence only; the public CI receipt remains free of
    // native paths and raw observations. Never overwrite an existing artifact.
    const { signal: _signal, ...capturedWindow } = window
    writeFileSync(editCapturePath, JSON.stringify({ kind: 'TEST_NATIVE_V2_EDIT_CAPTURE', workspace,
      before: capturedBefore, after: capturedAfter, window: capturedWindow }, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' })
  }
  receipt.steps.push('session_SPI_native_builtin_edit_immutable_input_window_and_real_log_anchors')
  await runInput('image')
  await until(() => resultFor('image') || fixtureFailure, 'native_PNG_terminal_missing')
  check(resultFor('image')?.outcome === 'succeeded' && !fixtureFailure && pngInference && pngResolutions === 1, 'native_PNG_terminal')
  receipt.steps.push('session_SPI_original_verified_PNG_native_ACK_history_and_actual_image_inference')
  await runInput('interrupt')
  await until(() => streamOpen || fixtureFailure, 'active_stream_missing')
  check((await driver.interrupt('TEST-op-interrupt')).ok, 'interrupt_receipt')
  await until(() => resultFor('interrupt') && streamClosed || fixtureFailure, 'interrupt_terminal_or_stream_close_missing')
  check(resultFor('interrupt')?.outcome === 'cancelled' && streamClosed, 'interrupt_not_confirmed')
  await until(() => driver.checkpoint().ok, 'idle_checkpoint_missing')
  checkpoint = driver.checkpoint().value
  check(readOpenCodeV2CheckpointSessionId(checkpoint) === created.id, 'checkpoint_native_identity')
  const closed = await driver.close(); await observer; driver = undefined; observer = undefined
  check(closed.cleanup === 'confirmed' && !running, 'native_stop_cleanup')
  await owner.dispose(); owner = undefined
  receipt.steps.push('session_SPI_active_stream_interrupt_native_terminal_and_stop')
  const callsBeforeRestore = modelCalls
  phase = 'restore'
  const restoredEndpoint = await startNative()
  check(restoredEndpoint !== firstEndpoint, 'cold_endpoint_not_rebound')
  owner = createOpenCodeV2OwnedSessionClient(transportConfig(restoredEndpoint))
  check((await owner.readSession()).id === created.id, 'cold_session_missing')
  check(await owner.savedPermissionsEmpty(), 'saved_grants_after_once')
  check(await owner.builtinPluginsOnly(), 'non_builtin_plugins_after_restore')
  check((await owner.instructions()).some(row => row.key === 'test-native-spi' && row.value === marker), 'cold_instructions_missing')
  binding.generation++
  const previousEventCount = events.length
  driver = (await factory(restoredEndpoint).open({ ...request(), checkpointRef: 'TEST-durable-checkpoint' })).driver; observe()
  await delay(200)
  check(modelCalls === callsBeforeRestore && mcpCalls === 1 && events.length === previousEventCount
    && readFileSync(editPath, 'utf8') === editAfter && captureRequests.length === 2 && pngResolutions === 1, 'cold_replay')
  await runInput('resumed')
  await until(() => resultFor('resumed') || fixtureFailure, 'resumed_terminal_missing')
  check(resultFor('resumed')?.outcome === 'succeeded' && mcpCalls === 1 && !fixtureFailure, 'resumed_result')
  check(pngColdHistory && pngResolutions === 1, 'native_PNG_cold_history_without_resubmit')
  receipt.nativePNG = { mimeType: 'image/png', sha256: pngReference.digest, byteLength: pngBytes.length,
    resolutions: pngResolutions, actualInference: pngInference, coldHistory: pngColdHistory, resubmitted: false }
  receipt.steps.push('cold_same_session_new_endpoint_checkpoint_no_replay_and_fresh_input')
  receipt.modelRequests = modelCalls; receipt.mcpEffects = mcpCalls
  receipt.instructionsEffective = instructionsSeen; receipt.nativeCatalogEffective = catalogSeen
  receipt.platform = `${process.platform}-${process.arch}`
  receipt.completed = true
} catch (error) {
  failed = true
  receipt.failure = error instanceof Error && /^TEST_SPI_[a-zA-Z0-9_]{1,96}$/.test(error.message)
    ? error.message : 'TEST_SPI_native_or_driver_failure'
  receipt.phase = phase
  receipt.lastNativeStatus = lastNativeStatus
  const refusal = ['authority_mismatch', 'native_identity_mismatch', 'invalid_response', 'http_failure', 'media_type',
    'transport_failure', 'deadline', 'invalid_native_identity', 'invalid_native_permissions', 'native_selection_mismatch', 'invalid_native_plugins']
  if (refusal.includes(error?.message)) receipt.refusal = error.message
} finally {
  let cleaned = true
  // A failed earlier cleanup must not skip the remaining owned resources.
  for (const close of [
    async () => { if (driver) check((await driver.close()).cleanup === 'confirmed', 'final_driver_cleanup') },
    async () => { await observer }, async () => { await owner?.dispose() },
    async () => { await stopNative() }, async () => { await stopServer(model) },
    async () => { await stopServer(mcp) },
    // Windows refuses to remove the process's current directory. Leave the
    // disposable workspace only after the native engine and servers are closed.
    async () => { process.chdir(originalDirectory); rmSync(root, { recursive: true, force: true }) },
  ]) {
    try { await close() } catch { cleaned = false }
  }
  receipt.cleanup = cleaned
  if (!cleaned) failed = true
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
}
if (failed || !receipt.completed || !receipt.cleanup) process.exitCode = 1
console.log(JSON.stringify(receipt))
