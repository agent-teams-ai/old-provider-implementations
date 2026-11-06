// TEST-only native model binding discovery; no prompt or real model call.
import { createHash, randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const receiptPath = resolve(process.env.OPENCODE_V2_TEST_MODEL_RECEIPT || 'native-v2-model-candidate.json')
const receipt = { kind: 'TEST_NATIVE_V2_MODEL_BINDING_ONLY', qualified: false, steps: [], cleanup: false }
const root = mkdtempSync(join(tmpdir(), 'TEST-v2-model-binding-'))
const directory = join(root, 'workspace')
for (const part of ['workspace', 'home', 'config', 'cache', 'data', 'state', 'temp']) mkdirSync(join(root, part), { recursive: true })
const password = randomBytes(24).toString('hex')
const env = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: join(root, 'home'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_STATE_HOME: join(root, 'state'),
  TMPDIR: join(root, 'temp'),
  OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_SERVER_USERNAME: 'opencode',
  CI: 'true', NO_COLOR: '1',
}
let native, fake, nativeStartTicks
let failed = false
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const version = '2.0.21'
const expectedDigest = 'f916986543348d7953d8d43aa048516cdbc3f84f4d0dc9c0c5b9d1da3030cea7'

async function request(url, authorization, operation = {}) {
  const headers = authorization ? { authorization } : {}
  if (operation.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(url, {
    method: operation.method || 'GET', redirect: 'error', headers,
    body: operation.body === undefined ? undefined : JSON.stringify(operation.body),
    signal: AbortSignal.timeout(operation.timeoutMs || 2500),
  })
  const body = await response.text()
  if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw Error('TEST_response_too_large')
  return { status: response.status, json: body ? JSON.parse(body) : null }
}
// A detached TEST-owned native group must be fenced by its leader's Linux
// process start identity before any signal, not only by a recyclable PID.
function ownedStartTicks(pid) {
  let stat
  try { stat = readFileSync('/proc/' + pid + '/stat', 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const commandEnd = stat.lastIndexOf(') ')
  if (commandEnd < 0) throw Error('TEST_invalid_native_process_stat')
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/)
  const ticks = fields[19]
  if (!/^\d+$/.test(ticks ?? '') || Number(fields[2]) !== pid ||
      Number(fields[3]) !== pid)
    throw Error('TEST_native_process_group_not_owned')
  return ticks
}
function processPresent(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function closeNative() {
  if (!native?.pid) return
  const pid = native.pid
  const currentTicks = ownedStartTicks(pid)
  if (!currentTicks || currentTicks !== nativeStartTicks) {
    if (currentTicks === null && !processPresent(pid) && !processPresent(-pid)) {
      receipt.cleanup = true
      return
    }
    throw Error('TEST_native_process_identity_changed_before_stop')
  }
  try { process.kill(-pid, 'SIGTERM') }
  catch (error) { if (error.code !== 'ESRCH') throw error }
  for (let i = 0; i < 30; i++) {
    if (!processPresent(pid) && !processPresent(-pid)) {
      receipt.cleanup = true
      return
    }
    await delay(100)
  }
  // Never target an orphan process group or a recycled leader PID.
  if (!processPresent(pid) || ownedStartTicks(pid) !== nativeStartTicks)
    throw Error('TEST_native_group_outlived_owned_leader')
  try { process.kill(-pid, 'SIGKILL') }
  catch (error) { if (error.code !== 'ESRCH') throw error }
  for (let i = 0; i < 10; i++) {
    if (!processPresent(pid) && !processPresent(-pid)) {
      receipt.cleanup = true
      return
    }
    await delay(100)
  }
  throw Error('TEST_native_process_group_cleanup_unconfirmed')
}
try {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('unsupported_TEST_runner')
  if (!process.report?.getReport()?.header?.glibcVersionRuntime ||
      !/(^|\s)avx2(\s|$)/i.test(readFileSync('/proc/cpuinfo', 'utf8')))
    throw Error('TEST_AVX2_glibc_runner_required')
  const npmRoot = process.env.OPENCODE_V2_TEST_NPM_ROOT
  if (!npmRoot?.startsWith('/')) throw Error('missing_TEST_npm_root')
  const prefix = realpathSync(npmRoot)
  const packageDir = realpathSync(join(prefix, 'cli-linux-x64'))
  if (!packageDir.startsWith(prefix + '/')) throw Error('untrusted_TEST_package_path')
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (manifest.name !== '@opencode/cli-linux-x64' || manifest.version !== version)
    throw Error('wrong_TEST_native_package')
  const binary = realpathSync(join(packageDir, 'bin', 'opencode'))
  if (!binary.startsWith(packageDir + '/')) throw Error('untrusted_TEST_executable_path')
  const bytes = readFileSync(binary)
  if (bytes.subarray(0, 4).toString('hex') !== '7f454c46' || sha256(bytes) !== expectedDigest)
    throw Error('unqualified_TEST_executable_sha256')
  const banner = execFileSync(binary, ['--version'], { env, cwd: directory, timeout: 12000, encoding: 'utf8' }).trim()
  if (banner !== 'opencode v' + version) throw Error('wrong_TEST_native_version')
  receipt.steps.push('pre_execution_native_elf_version_digest_verified')

  // Isolated fake provider never forwards requests or accepts external traffic.
  let attemptedInference = 0, modelCalls = 0, fakeFailure = null, allowInference = false
  const fakeMarker = 'TEST_NATIVE_V2_LOCAL_MODEL_REPLY'
  fake = createServer((req, res) => {
    if (!allowInference) {
      attemptedInference++
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end('{"error":"TEST_model_turn_not_authorized"}')
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      fakeFailure = 'unexpected_TEST_inference_path'
      res.writeHead(404).end()
      return
    }
    let body = '', bytes = 0
    req.on('data', chunk => {
      bytes += chunk.byteLength
      if (bytes > 2 * 1024 * 1024) {
        fakeFailure = 'unbounded_TEST_inference_request'
        req.destroy()
      } else body += chunk.toString()
    })
    req.on('end', () => {
      try {
        const payload = JSON.parse(body)
        if (payload.model !== 'TEST-native-model' || payload.stream !== true)
          throw Error('unexpected_TEST_inference_model_or_mode')
        modelCalls++
        const shared = { id: 'chatcmpl-TEST-native', object: 'chat.completion.chunk',
          created: 1, model: 'TEST-native-model' }
        const delta = (value, finish = null) => ({ ...shared,
          choices: [{ index: 0, delta: value, finish_reason: finish }] })
        const frames = [
          delta({ role: 'assistant' }),
          delta({ content: fakeMarker }),
          delta({}, 'stop'),
          { ...shared, choices: [], usage: { prompt_tokens: 20,
            completion_tokens: 8, total_tokens: 28 } },
        ].map(value => 'data: ' + JSON.stringify(value))
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache' })
        res.end([...frames, 'data: [DONE]'].join('\n\n') + '\n\n')
      } catch (error) {
        fakeFailure = 'TEST_native_fake_model_handler_failed'
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{"error":"TEST_invalid_fake_inference"}')
      }
    })
  })
  await new Promise((ok, fail) => fake.once('error', fail).listen(0, '127.0.0.1', ok))
  const addr = fake.address()
  if (!addr || typeof addr === 'string') throw Error('TEST_fake_listener_unavailable')
  mkdirSync(join(directory, '.opencode'))
  const modelID = 'TEST-native-model', providerID = 'test-native'
  const config = {
    model: providerID + '/' + modelID,
    update: 'disable',
    providers: {
      [providerID]: {
        name: 'TEST isolated local provider',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: 'http://127.0.0.1:' + addr.port + '/v1', apiKey: 'TEST-not-a-secret' },
        models: { [modelID]: { name: 'TEST no-network model',
          capabilities: { tools: false, input: ['text'], output: ['text'] },
          limit: { context: 8192, output: 1024 } } },
      },
    },
  }
  writeFileSync(join(directory, '.opencode', 'opencode.json'), JSON.stringify(config), { mode: 0o600 })
  receipt.steps.push('TEST_workspace_local_provider_config_written')
  const auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')
  const port = await new Promise((ok, fail) => {
    const server = createServer()
    server.once('error', fail).listen(0, '127.0.0.1', () => {
      const location = server.address()
      if (!location || typeof location === 'string') { fail(Error('TEST_native_port')); return }
      server.close(error => error ? fail(error) : ok(location.port))
    })
  })
  native = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: directory, env, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
  })
  if (!native.pid) throw Error('TEST_native_spawn_failed')
  await once(native, 'spawn')
  nativeStartTicks = ownedStartTicks(native.pid)
  if (!nativeStartTicks) throw Error('TEST_native_owned_process_start_unavailable')
  receipt.ownedProcessStartTicks = nativeStartTicks
  if (sha256(readFileSync('/proc/' + native.pid + '/exe')) !== expectedDigest)
    throw Error('TEST_native_process_digest_mismatch')
  const endpoint = 'http://127.0.0.1:' + port
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const info = await request(endpoint + '/api/info', auth)
      if (info.status === 200 && info.json?.version === version && info.json?.pid === native.pid) {
        ready = true
        break
      }
    } catch { /* readiness only */ }
    await delay(250)
  }
  if (!ready) throw Error('TEST_native_server_not_ready')
  receipt.steps.push('TEST_native_model_server_identity_verified')

  const configRead = await request(endpoint + '/api/config', auth, { timeoutMs: 15000 })
  const entries = Array.isArray(configRead.json) ? configRead.json : []
  const hasTestConfig = entries.some(item =>
    item?.type === 'document' && item?.info?.providers?.[providerID]?.package ===
      '@opencode/ai/providers/openai-compatible')
  receipt.configDiscovery = { status: configRead.status, documentCount: entries.length,
    hasTestConfig }
  let available, preferred, items, selected, attempts = 0
  // Config/model plugin settlement may lag native server readiness.
  for (attempts = 1; attempts <= 40; attempts++) {
    available = await request(endpoint + '/api/model', auth, { timeoutMs: 3000 })
    preferred = await request(endpoint + '/api/model/default', auth, { timeoutMs: 3000 })
    items = available.json?.data; selected = preferred.json?.data
    if (available.status === 200 && preferred.status === 200 &&
        Array.isArray(items) &&
        items.some(item => item.id === modelID && item.providerID === providerID) &&
        selected?.id === modelID && selected?.providerID === providerID) break
    await delay(250)
  }
  receipt.modelDiscovery = { listStatus: available?.status, defaultStatus: preferred?.status,
    modelCount: Array.isArray(items) ? items.length : null,
    selectedID: selected?.id ?? null, selectedProvider: selected?.providerID ?? null,
    snapshotAttempts: attempts, fakeInferenceRequests: attemptedInference }
  if (configRead.status !== 200 || !hasTestConfig ||
      available?.status !== 200 || preferred?.status !== 200 || !Array.isArray(items) ||
      !items.some(item => item.id === modelID && item.providerID === providerID) ||
      selected?.id !== modelID || selected?.providerID !== providerID ||
      attemptedInference !== 0)
    throw Error('TEST_native_local_model_binding_not_qualified')
  receipt.steps.push('TEST_native_local_model_selected_without_inference')
  // Only after native API proves the exact TEST default do we enable
  // model inference, with a single loopback-only fake provider.
  allowInference = true
  const created = await request(endpoint + '/api/session', auth, { method: 'POST', timeoutMs: 12000,
    body: { location: { directory }, agent: 'build', model: { providerID, id: modelID },
      permissions: [{ action: 'external_directory', resource: '*', effect: 'deny' },
        { action: 'shell', resource: '*', effect: 'deny' }] },
  })
  const session = created.json?.data
  if (created.status !== 200 || typeof session?.id !== 'string' || !session.id.startsWith('ses_') ||
      session?.location?.directory !== directory || session?.model?.providerID !== providerID ||
      session?.model?.id !== modelID)
    throw Error('TEST_native_model_session_binding_failed')
  receipt.steps.push('TEST_native_model_session_created')
  const url = endpoint + '/api/session/' + encodeURIComponent(session.id)
  const inputID = 'msg_TESTnativeModelTurn'
  const submitted = await request(url + '/prompt', auth, { method: 'POST', timeoutMs: 12000,
    body: { id: inputID, text: 'TEST echo the deterministic local marker',
      delivery: 'queue', resume: true },
  })
  if (submitted.status !== 200 || submitted.json?.data?.id !== inputID ||
      submitted.json?.data?.sessionID !== session.id || submitted.json?.data?.type !== 'user')
    throw Error('TEST_native_model_prompt_not_admitted')
  receipt.steps.push('TEST_native_real_prompt_admitted')
  let assistant = null, messageKinds = [], lastError = null
  for (let i = 0; i < 80; i++) {
    try {
      const page = await request(url + '/message?limit=200', auth, { timeoutMs: 3500 })
      if (page.status === 200 && Array.isArray(page.json?.data)) {
        const messages = page.json.data
        messageKinds = messages.map(item => item?.type ?? null).slice(0, 24)
        assistant = messages.find(item => item?.type === 'assistant' &&
          JSON.stringify(item).includes(fakeMarker)) || null
        if (assistant) break
      }
    } catch (error) { lastError = String(error instanceof Error ? error.message : error) }
    await delay(500)
  }
  receipt.modelTurn = { promptStatus: submitted.status, modelCalls,
    fakeFailure, messageKinds, assistantPresent: assistant !== null,
    lastReadError: lastError }
  if (fakeFailure || modelCalls < 1 || !assistant)
    throw Error('TEST_native_real_model_turn_not_observed')
  receipt.steps.push('TEST_native_fake_model_assistant_message_received')
  // Stock CLI does not retain event payloads in Session.log by default.
  // Inspect the separate source-defined terminal projections without silently
  // upgrading them to authoritative input-to-terminal event lineage.
  let nativeSessionState, terminalMessages = []
  for (let attempt = 0; attempt < 24; attempt++) {
    const [state, page] = await Promise.all([
      request(url, auth, { timeoutMs: 3500 }),
      request(url + '/message?limit=200', auth, { timeoutMs: 3500 }),
    ])
    nativeSessionState = state.status === 200 ? state.json?.data : undefined
    terminalMessages = page.status === 200 && Array.isArray(page.json?.data) ? page.json.data : []
    const idle = terminalMessages.filter(item => item?.type === 'idle')
    if (nativeSessionState?.outcome && nativeSessionState?.time?.idle &&
        idle.length > 0) break
    await delay(250)
  }
  const originalUsers = terminalMessages.filter(item =>
    item?.type === 'user' && item?.id === inputID)
  const originalAssistants = terminalMessages.filter(item =>
    item?.type === 'assistant' && item?.id === assistant.id &&
    item?.agent === 'build' && item?.model?.providerID === providerID &&
    item?.model?.id === modelID && JSON.stringify(item).includes(fakeMarker))
  const idleRows = terminalMessages.filter(item => item?.type === 'idle')
  receipt.nativeTerminalProjection = {
    sessionOutcome: nativeSessionState?.outcome ?? null,
    sessionIdle: nativeSessionState?.time?.idle ?? null,
    inputRows: originalUsers.length, assistantRows: originalAssistants.length,
    idleOutcomes: idleRows.map(item => item.outcome).slice(0, 12),
    assistantFinished: originalAssistants[0]?.time?.completed !== undefined,
  }
  if (nativeSessionState?.id !== session.id || nativeSessionState?.outcome !== 'succeeded' ||
      !Number.isFinite(nativeSessionState?.time?.idle) ||
      originalUsers.length !== 1 || originalAssistants.length !== 1 ||
      !Number.isFinite(originalAssistants[0]?.time?.completed) ||
      idleRows.length !== 1 || idleRows[0]?.outcome !== 'succeeded')
    throw Error('TEST_native_model_terminal_projection_not_qualified')
  receipt.steps.push('TEST_native_session_outcome_and_idle_consistent')

  // A visible assistant message is not sufficient without a trustworthy native
  // terminal event. Keep this a stop-ship gate; do not infer completion from text.
  const logResponse = await fetch(endpoint + '/api/experimental/session/' +
    encodeURIComponent(session.id) + '/log?follow=false', {
    redirect: 'error', headers: { authorization: auth }, signal: AbortSignal.timeout(12000),
  })
  const sse = await logResponse.text()
  if (Buffer.byteLength(sse) > 2 * 1024 * 1024) throw Error('TEST_native_model_log_too_large')
  const frames = sse.replace(/\r\n/g, '\n').split('\n\n').flatMap(frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n')
    return data ? [JSON.parse(data)] : []
  })
  const events = frames.slice(0, -1), sync = frames.at(-1)
  receipt.modelTurn.sessionLog = { status: logResponse.status,
    visibleTypes: events.map(item => item?.type ?? null).slice(0, 40),
    watermark: sync?.seq ?? null, synced: sync?.type === 'log.synced' }
  const nativeTerminalVisible = logResponse.status === 200 &&
    sync?.aggregateID === session.id &&
    events.some(event => event?.type === 'session.execution.succeeded')
  // Preserve the exact TEST session and model history through a real process
  // replacement, even when the native SSE terminal remains unqualified.
  const priorAssistantID = assistant.id
  const modelCallsBeforeCold = modelCalls
  await closeNative()
  if (!receipt.cleanup) throw Error('TEST_native_model_cold_stop_unconfirmed')
  receipt.steps.push('TEST_native_model_cold_stop_confirmed')
  const testPort = createNetServer()
  await new Promise((ok, fail) => testPort.once('error', fail).listen(0, '127.0.0.1', ok))
  const testAddress = testPort.address()
  if (!testAddress || typeof testAddress === 'string') throw Error('TEST_model_restart_port_unavailable')
  const coldPort = testAddress.port
  await new Promise((ok, fail) => testPort.close(error => error ? fail(error) : ok()))
  receipt.cleanup = false
  native = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(coldPort)], {
    cwd: directory, env, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
  })
  if (!native.pid) throw Error('TEST_model_restart_spawn_failed')
  await once(native, 'spawn')
  nativeStartTicks = ownedStartTicks(native.pid)
  if (!nativeStartTicks) throw Error('TEST_model_restart_owned_process_start_unavailable')
  receipt.coldProcessStartTicks = nativeStartTicks
  if (sha256(readFileSync('/proc/' + native.pid + '/exe')) !== expectedDigest)
    throw Error('TEST_model_restart_executable_digest_mismatch')
  const coldEndpoint = 'http://127.0.0.1:' + coldPort
  let coldReady = false
  for (let i = 0; i < 60; i++) {
    try {
      const info = await request(coldEndpoint + '/api/info', auth, { timeoutMs: 2500 })
      if (info.status === 200 && info.json?.version === version &&
          info.json?.pid === native.pid) { coldReady = true; break }
    } catch { /* new TEST process readiness only */ }
    await delay(250)
  }
  if (!coldReady) throw Error('TEST_native_model_cold_restart_not_ready')
  const coldURL = coldEndpoint + '/api/session/' + encodeURIComponent(session.id)
  const coldSession = await request(coldURL, auth)
  const coldPage = await request(coldURL + '/message?limit=200', auth)
  const coldMessages = coldPage.json?.data
  const originalUserRows = Array.isArray(coldMessages)
    ? coldMessages.filter(item => item?.id === inputID && item?.type === 'user') : []
  const preservedAssistants = Array.isArray(coldMessages)
    ? coldMessages.filter(item => item?.id === priorAssistantID && item?.type === 'assistant' &&
        JSON.stringify(item).includes(fakeMarker)) : []
  receipt.coldModelTurn = { sessionRead: coldSession.status,
    messageRead: coldPage.status, userRecords: originalUserRows.length,
    preservedAssistantRecords: preservedAssistants.length,
    modelCallsBeforeCold, modelCallsAfterCold: modelCalls }
  if (coldSession.status !== 200 || coldSession.json?.data?.id !== session.id ||
      coldPage.status !== 200 || originalUserRows.length !== 1 ||
      preservedAssistants.length !== 1 || modelCalls !== modelCallsBeforeCold)
    throw Error('TEST_native_model_cold_history_or_no_replay_failed')
  const coldIdleRows = coldMessages.filter(item => item?.type === 'idle')
  receipt.coldModelTurn.sessionOutcome = coldSession.json?.data?.outcome ?? null
  receipt.coldModelTurn.sessionIdle = coldSession.json?.data?.time?.idle ?? null
  receipt.coldModelTurn.idleOutcomes = coldIdleRows.map(item => item?.outcome).slice(0, 12)
  if (coldSession.json?.data?.outcome !== 'succeeded' ||
      coldSession.json?.data?.time?.idle !== nativeSessionState.time.idle ||
      coldIdleRows.length !== 1 || coldIdleRows[0]?.outcome !== 'succeeded')
    throw Error('TEST_native_model_cold_terminal_projection_changed')
  receipt.steps.push('TEST_native_model_cold_history_retained_without_replay')
  const removed = await request(coldURL, auth, { method: 'DELETE', timeoutMs: 12000 })
  if (removed.status !== 204) throw Error('TEST_native_model_session_delete_failed')
  receipt.steps.push('TEST_native_model_session_removed')
  if (!nativeTerminalVisible) throw Error('TEST_native_model_terminal_event_not_qualified')
  receipt.steps.push('TEST_native_model_execution_terminal_verified')
} catch (error) {
  failed = true
  receipt.failure = error instanceof Error && /^TEST_[A-Za-z0-9_]{1,96}$/u.test(error.message)
    ? error.message : 'TEST_native_model_unexpected_failure'
} finally {
  try { await closeNative() } catch {
    failed = true; receipt.cleanupFailure = 'TEST_native_model_process_cleanup_failed'
  }
  if (fake) {
    try {
      fake.closeAllConnections()
      await new Promise((ok, fail) => fake.close(error => error ? fail(error) : ok()))
    } catch { failed = true; receipt.fakeCleanupFailure = 'TEST_native_model_fake_cleanup_failed' }
  }
  try { rmSync(root, { recursive: true, force: true }) }
  catch { failed = true; receipt.directoryCleanupFailure = 'TEST_native_model_directory_cleanup_failed' }
  receipt.completed = !failed && receipt.cleanup
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ completed: receipt.completed, steps: receipt.steps, failure: receipt.failure }))
}
if (!receipt.completed) process.exitCode = 1
