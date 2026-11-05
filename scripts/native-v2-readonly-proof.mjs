// TEST-only binary discovery. Not a production Host launch and not a native V01 certificate.
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const version = '2.0.21'
const receiptPath = resolve(process.env.OPENCODE_V2_TEST_RECEIPT || 'native-v2-readonly-proof.json')
const receipt = { kind: 'TEST_NATIVE_SESSION_LIFECYCLE_ONLY', version, qualified: false, steps: [], cleanup: false }
const root = mkdtempSync(join(tmpdir(), 'TEST-opencode-v2-'))
const directory = join(root, 'workspace')
for (const dir of ['workspace', 'home', 'config', 'cache', 'data', 'state', 'temp']) mkdirSync(join(root, dir))
const password = randomBytes(24).toString('hex')
// Intentionally no user credentials, inherited XDG state, real HOME or provider keys.
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
let child
let failed = false
const hash = (data) => createHash('sha256').update(data).digest('hex')
/** Match the official v2.0.21 launcher candidate for glibc x64, but run the native ELF directly.
 * Source: anomalyco/opencode@8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72
 * packages/cli/bin/opencode.cjs. Do not fall back to another architecture or to OPENCODE_BIN_PATH. */
function discoverSingleNativeBinary(npmRoot) {
  const base = realpathSync(npmRoot)
  const glibc = process.report?.getReport()?.header?.glibcVersionRuntime
  if (!glibc) throw Error('expected_ubuntu_glibc_runner')
  const supportsAvx2 = /(^|\s)avx2(\s|$)/i.test(readFileSync('/proc/cpuinfo', 'utf8'))
  const packageName = supportsAvx2 ? 'cli-linux-x64' : 'cli-linux-x64-baseline'
  const packageDirectory = realpathSync(join(base, packageName))
  if (!packageDirectory.startsWith(base + '/')) throw Error('native_package_outside_test_prefix')
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
  if (manifest.name !== '@opencode/' + packageName || manifest.version !== version)
    throw Error('native_package_name_or_version_mismatch')
  const native = realpathSync(join(packageDirectory, 'bin', 'opencode'))
  if (!native.startsWith(packageDirectory + '/')) throw Error('native_binary_outside_test_package')
  receipt.platformPackage = manifest.name
  receipt.avx2 = supportsAvx2
  return native
}
async function freePort() {
  const server = createServer()
  await new Promise((ok, reject) => server.once('error', reject).listen(0, '127.0.0.1', ok))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw Error('no_test_loopback_port')
  await new Promise((ok, reject) => server.close(err => err ? reject(err) : ok()))
  return addr.port
}
async function request(url, authorization, operation = {}) {
  const headers = authorization ? { authorization } : {}
  if (operation.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(url, {
    method: operation.method ?? 'GET', redirect: 'error',
    headers, body: operation.body === undefined ? undefined : JSON.stringify(operation.body),
    signal: AbortSignal.timeout(operation.timeoutMs ?? 2500),
  })
  const content = await response.text()
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw Error('unbounded_server_response')
  return { status: response.status, content, contentType: response.headers.get('content-type') }
}
/** Drop only the HTTP acknowledgement after the native TEST server committed one
 * synthetic input. The consumer must reconcile by ID and must not resubmit. */
async function submitWithLostAck(nativeURL, authorization, payload) {
  let forwarded = 0
  let accepted = false
  let proxyFailure
  const proxy = createHttpServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/TEST-drop-ack' || ++forwarded !== 1) {
      res.writeHead(404).end()
      return
    }
    req.resume()
    void (async () => {
      const response = await request(nativeURL, authorization, {
        method: 'POST', body: payload, timeoutMs: 12000,
      })
      const data = response.status === 200 ? JSON.parse(response.content)?.data : undefined
      if (data?.id !== payload.id) throw Error('native_lost_ack_input_not_admitted')
      accepted = true
      // Drop only this one client's acknowledgement; never kill the native owner.
      res.destroy()
    })().catch(error => {
      proxyFailure = error instanceof Error ? error.message : String(error)
      res.destroy()
    })
  })
  await new Promise((ok, reject) =>
    proxy.once('error', reject).listen(0, '127.0.0.1', ok))
  let clientLost = false
  try {
    const address = proxy.address()
    if (!address || typeof address === 'string') throw Error('lost_ack_proxy_not_bound')
    try {
      await request(`http://127.0.0.1:${address.port}/TEST-drop-ack`, undefined,
        { method: 'POST', body: { receipt: 'TEST-only' }, timeoutMs: 15000 })
    } catch {
      clientLost = true
    }
  } finally {
    proxy.closeAllConnections()
    await new Promise((ok, reject) => proxy.close(error => error ? reject(error) : ok()))
  }
  if (!clientLost || !accepted || forwarded !== 1 || proxyFailure)
    throw Error('native_lost_ack_injection_not_proved')
  return { clientLost, nativePOSTCount: forwarded, nativeAccepted: accepted }
}
async function readNativeServerInfo(endpoint, authorization, expectedPid) {
  let response
  for (let i = 0; i < 80; i++) {
    try {
      const candidate = await request(endpoint + '/api/info', authorization)
      if (candidate.status === 200) { response = candidate; break }
    } catch {
      // Readiness may lag spawn, but only an exact 200 API response is admitted.
    }
    await delay(250)
  }
  if (!response) throw Error('native_info_unavailable')
  const value = JSON.parse(response.content)
  if (value.version !== version || value.pid !== expectedPid ||
      !Array.isArray(value.urls) || typeof value.paths?.tmp !== 'string')
    throw Error('native_info_identity_mismatch')
  return value
}
async function closeOwnServer() {
  if (!child?.pid) return
  // detached=true made an exclusive process group. No process owned by another user is targeted.
  try { process.kill(-child.pid, 'SIGTERM') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  for (let i = 0; i < 20; i++) {
    try { process.kill(child.pid, 0) } catch (error) {
      if (error.code === 'ESRCH') { receipt.cleanup = true; return }
      throw error
    }
    await delay(100)
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  await delay(100)
  try { process.kill(child.pid, 0); receipt.cleanup = false }
  catch (error) { if (error.code === 'ESRCH') receipt.cleanup = true; else throw error }
}
try {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('unsupported_test_runner')
  const supplied = process.env.OPENCODE_V2_TEST_NPM_ROOT
  if (!supplied || !supplied.startsWith('/')) throw Error('missing_absolute_test_package_root')
  const binary = discoverSingleNativeBinary(supplied)
  const binaryBytes = readFileSync(binary)
  if (binaryBytes.subarray(0, 4).toString('hex') !== '7f454c46') throw Error('installed_cli_is_not_native_elf')
  receipt.binarySha256 = hash(binaryBytes)
  receipt.binaryRelativePath = binary.slice(realpathSync(supplied).length + 1)
  receipt.binaryBytes = binaryBytes.length
  receipt.steps.push('native_ELF_and_SHA256_recorded')
  // TEST-only discovery pin from Actions 41944140785, artifact 13377198137.
  // Independent upstream distribution provenance and product lock admission remain HOLD.
  const linuxX64Avx2TestDigest = 'f916986543348d7953d8d43aa048516cdbc3f84f4d0dc9c0c5b9d1da3030cea7'
  if (receipt.avx2 !== true || receipt.binarySha256 !== linuxX64Avx2TestDigest)
    throw Error('unqualified_native_binary_digest')
  receipt.steps.push('pre_execution_TEST_binary_SHA256_pin_verified')
  const reported = execFileSync(binary, ['--version'], { cwd: directory, env, encoding: 'utf8', timeout: 12000 }).trim()
  receipt.reportedVersion = reported
  // Exact observed official CLI prefix; never use substring or semver-coercion matching.
  if (reported !== `opencode v${version}`) throw Error('native_version_mismatch')
  receipt.steps.push('exact_native_version')
  const port = await freePort()
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: directory, env, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
  })
  if (!child.pid) throw Error('native_process_not_started')
  await once(child, 'spawn')
  receipt.ownedProcessPid = child.pid
  const observed = readFileSync(`/proc/${child.pid}/exe`)
  receipt.processExecutableSha256 = hash(observed)
  if (receipt.processExecutableSha256 !== receipt.binarySha256) throw Error('process_executable_digest_mismatch')
  receipt.steps.push('actual_TEST_owned_process_executable_digest')
  const endpoint = `http://127.0.0.1:${port}`
  const auth = `Basic ${Buffer.from('opencode:' + password).toString('base64')}`
  // Exact v2.0.21 contract from packages/protocol/src/groups/server.ts:
  // GET /api/info -> {version,pid,urls,paths}; OpenAPI lives at /openapi.json.
  // Legacy /global/health and /doc fall through to the HTML web app in V2.
  const value = await readNativeServerInfo(endpoint, auth, child.pid)
  receipt.serverInfo = { version: value.version, pidMatchesOwnedProcess: true }
  receipt.steps.push('authenticated_loopback_native_info')
  const denied = await request(endpoint + '/api/info')
  receipt.unauthenticatedStatus = denied.status
  if (denied.status !== 401) throw Error('loopback_auth_not_enforced')
  receipt.steps.push('unauthenticated_request_rejected')
  const spec = await request(endpoint + '/openapi.json', auth)
  receipt.openapi = { status: spec.status, contentType: spec.contentType, sha256: hash(spec.content) }
  if (spec.status !== 200 || !spec.content.includes('openapi')) throw Error('native_openapi_unavailable')
  receipt.steps.push('native_OpenAPI_retrievable')
  // Official v2.0.21 SessionGroup: POST /api/session, GET/DELETE /api/session/:sessionID.
  // Only this disposable TEST workspace and isolated HOME/DB may be mutated.
  // Never retry a POST if its acceptance/acknowledgement is ambiguous.
  // Restrictive TEST-only rules exercise the exact native ordered Permission.Ruleset
  // persistence. Their actual tool-enforcement semantics require separate E2E.
  const testPermissions = [
    { action: 'external_directory', resource: '*', effect: 'deny' },
    { action: 'shell', resource: '*', effect: 'ask' },
  ]
  const matchesPermissions = (value) => JSON.stringify(value) === JSON.stringify(testPermissions)
  const created = await request(endpoint + '/api/session', auth, {
    method: 'POST', timeoutMs: 12000, body: { location: { directory }, permissions: testPermissions },
  })
  if (created.status !== 200) throw Error('native_session_create_status_' + created.status)
  const createdData = JSON.parse(created.content)?.data
  const id = createdData?.id
  if (typeof id !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(id) ||
      createdData?.location?.directory !== directory ||
      !matchesPermissions(createdData.permissions)) throw Error('native_session_create_identity')
  receipt.steps.push('native_TEST_session_created')
  const url = endpoint + '/api/session/' + encodeURIComponent(id)
  const read = await request(url, auth)
  if (read.status !== 200) throw Error('native_session_read_status_' + read.status)
  const readData = JSON.parse(read.content)?.data
  if (readData?.id !== id || readData?.location?.directory !== directory ||
      !matchesPermissions(readData?.permissions))
    throw Error('native_session_read_identity')
  receipt.steps.push('native_TEST_session_readback')

  const unauthRead = await request(url)
  const unauthDelete = await request(url, undefined, { method: 'DELETE' })
  if (unauthRead.status !== 401 || unauthDelete.status !== 401)
    throw Error('native_session_authorization_bypass')
  const unchanged = await request(url, auth)
  if (unchanged.status !== 200 || JSON.parse(unchanged.content)?.data?.id !== id)
    throw Error('native_unauthorized_delete_applied')
  receipt.sessionAuthorization = { unauthenticatedRead: unauthRead.status,
    unauthenticatedDelete: unauthDelete.status, stillPresent: unchanged.status }
  receipt.steps.push('native_TEST_session_authz_denials')
  // A pending native permission is not a grant. Never create one from a guessed ID.
  const pendingURL = url + '/permission'
  const pending = await request(pendingURL, auth)
  if (pending.status !== 200 || !Array.isArray(JSON.parse(pending.content)?.data) ||
      JSON.parse(pending.content).data.length !== 0) throw Error('native_unexpected_pending_permission')
  const stalePermissionURL = pendingURL + '/per_TESTnotissued'
  const staleRead = await request(stalePermissionURL, auth)
  if (staleRead.status !== 404) throw Error('native_stale_permission_read_accepted')
  const staleReply = await request(stalePermissionURL + '/reply', auth, {
    method: 'POST', body: { decision: 'always' },
  })
  if (staleReply.status !== 404) throw Error('native_stale_permission_grant_accepted')
  receipt.steps.push('native_TEST_stale_permission_reply_rejected')

  // Exercise the real V2 Permission.Service.ask and reply routes. No model turn
  // or tool executes: only TEST-owned permission state is created and rejected.
  const deniedPermission = await request(pendingURL, auth, { method: 'POST',
    body: { action: 'external_directory', resources: ['/TEST/outside'] } })
  if (deniedPermission.status !== 200 || JSON.parse(deniedPermission.content)?.data?.effect !== 'deny')
    throw Error('native_explicit_external_directory_deny_failed')
  const asked = await request(pendingURL, auth, { method: 'POST',
    body: { action: 'shell', resources: ['*'] } })
  const askedData = asked.status === 200 ? JSON.parse(asked.content)?.data : undefined
  if (!askedData || askedData.effect !== 'ask' ||
      typeof askedData.id !== 'string' || !askedData.id.startsWith('per'))
    throw Error('native_shell_permission_ask_failed')
  const requested = await request(pendingURL, auth)
  const requests = requested.status === 200 ? JSON.parse(requested.content)?.data : undefined
  if (!Array.isArray(requests) || requests.length !== 1 ||
      requests[0]?.id !== askedData.id || requests[0]?.sessionID !== id)
    throw Error('native_pending_permission_not_session_scoped')
  receipt.steps.push('native_TEST_permission_ask_pending_owned')
  // A foreign TEST session may not inspect or grant this pending request.
  const otherSession = await request(endpoint + '/api/session', auth, { method: 'POST',
    timeoutMs: 12000, body: { location: { directory }, permissions: testPermissions } })
  const otherID = otherSession.status === 200 ? JSON.parse(otherSession.content)?.data?.id : undefined
  if (typeof otherID !== 'string' || otherID === id || !otherID.startsWith('ses_'))
    throw Error('native_second_TEST_session_not_distinct')
  const otherURL = endpoint + '/api/session/' + encodeURIComponent(otherID)
  const foreignPermissionURL = otherURL + '/permission/' + encodeURIComponent(askedData.id)
  const foreignPermissionRead = await request(foreignPermissionURL, auth)
  if (foreignPermissionRead.status !== 404) throw Error('native_foreign_permission_exposed')
  const foreignPermissionReply = await request(foreignPermissionURL + '/reply', auth, {
    method: 'POST', body: { decision: 'always' },
  })
  if (foreignPermissionReply.status !== 404) throw Error('native_foreign_permission_grant_accepted')
  const ownedAfterForeign = await request(pendingURL, auth)
  const retained = ownedAfterForeign.status === 200 ? JSON.parse(ownedAfterForeign.content)?.data : undefined
  if (!Array.isArray(retained) || retained.length !== 1 || retained[0]?.id !== askedData.id)
    throw Error('native_foreign_permission_changed_owner')
  receipt.steps.push('native_TEST_foreign_permission_read_and_grant_rejected')
  const replyURL = pendingURL + '/' + encodeURIComponent(askedData.id) + '/reply'
  const rejected = await request(replyURL, auth, { method: 'POST', body: { decision: 'reject' } })
  if (rejected.status !== 204) throw Error('native_permission_reject_failed')
  const duplicate = await request(replyURL, auth, { method: 'POST', body: { decision: 'once' } })
  if (duplicate.status !== 404) throw Error('native_permission_reply_replayed')
  const cleared = await request(pendingURL, auth)
  if (cleared.status !== 200 || !Array.isArray(JSON.parse(cleared.content)?.data) ||
      JSON.parse(cleared.content).data.length !== 0)
    throw Error('native_permission_pending_not_cleared')
  receipt.nativePermissionEvaluation = { externalDirectory: 'deny', shell: 'ask',
    ownedPending: 1, reject: rejected.status, replay: duplicate.status, remaining: 0 }
  receipt.steps.push('native_TEST_permission_rejected_and_not_replayable')
  // Synthetic input with resume:false is a durable inbox record, not a model
  // turn. The official Inbox admits repeated identical IDs without a second row.
  const inboxID = 'msg_TESTnativeQueued'
  const synthetic = { id: inboxID, text: 'TEST-native-durable-inbox-no-model',
    description: 'isolated native E2E', delivery: 'queue', resume: false }
  const syntheticURL = url + '/synthetic'
  const admitted = await request(syntheticURL, auth, { method: 'POST',
    timeoutMs: 12000, body: synthetic })
  const admittedData = admitted.status === 200 ? JSON.parse(admitted.content)?.data : undefined
  if (!admittedData || admittedData.id !== inboxID || admittedData.sessionID !== id ||
      admittedData.type !== 'synthetic' || admittedData.payload?.text !== synthetic.text)
    throw Error('native_synthetic_admission_mismatch')
  const repeated = await request(syntheticURL, auth, { method: 'POST',
    timeoutMs: 12000, body: synthetic })
  if (repeated.status !== 200 || JSON.parse(repeated.content)?.data?.id !== inboxID)
    throw Error('native_synthetic_idempotent_readback_failed')
  // Pinned v2.0.21 Inbox.reconcile uses session + input type as the
  // idempotency boundary, so a changed duplicate must retain the first payload.
  // A Host must never interpret a 200 replay as acceptance of changed content.
  const changedDuplicate = await request(syntheticURL, auth, { method: 'POST',
    timeoutMs: 12000, body: { ...synthetic, text: 'TEST-changed-replay-ignored' } })
  const firstWriter = changedDuplicate.status === 200 ? JSON.parse(changedDuplicate.content)?.data : undefined
  if (firstWriter?.id !== inboxID || firstWriter?.payload?.text !== synthetic.text)
    throw Error('native_synthetic_first_writer_not_retained')

  // An inbox ID belongs to exactly one session. Never allow a foreign session
  // to adopt the first session's durable input after a retry or restore.
  const foreign = await request(otherURL + '/synthetic', auth, { method: 'POST',
    timeoutMs: 12000, body: { ...synthetic, text: 'TEST-foreign-owner-collision' } })
  if (foreign.status !== 409) throw Error('native_cross_session_inbox_id_accepted')
  const foreignInbox = await request(otherURL + '/inbox', auth)
  const foreignRows = foreignInbox.status === 200 ? JSON.parse(foreignInbox.content)?.data : undefined
  if (!Array.isArray(foreignRows) || foreignRows.length !== 0)
    throw Error('native_foreign_session_inbox_mutated')
  const removedOther = await request(otherURL, auth, { method: 'DELETE', timeoutMs: 12000 })
  if (removedOther.status !== 204) throw Error('native_second_TEST_session_cleanup_failed')
  receipt.crossSessionIdempotency = { changedDuplicate: changedDuplicate.status,
    preservedFirstWriter: true, foreignCollision: foreign.status, foreignInboxItems: 0,
    foreignPermissionRead: foreignPermissionRead.status,
    foreignPermissionReply: foreignPermissionReply.status,
    foreignSessionCleanup: removedOther.status }
  receipt.steps.push('native_TEST_first_writer_wins_and_foreign_collision_denied')
  const queue = await request(url + '/inbox', auth)
  const queued = queue.status === 200 ? JSON.parse(queue.content)?.data : undefined
  if (!Array.isArray(queued) || queued.length !== 1 || queued[0]?.id !== inboxID ||
      queued[0]?.payload?.text !== synthetic.text || queued[0]?.delivery !== 'queue')
    throw Error('native_synthetic_inbox_not_single')
  receipt.steps.push('native_TEST_durable_synthetic_inbox_single')
  // The native server admits this exact TEST ID, but a loopback proxy drops
  // the response after the native 200. Reconcile by readback, NOT by retry.
  const lostID = 'msg_TESTlostNativeAck'
  const lostAck = await submitWithLostAck(syntheticURL, auth, {
    id: lostID, text: 'TEST-once-after-lost-ack', delivery: 'queue', resume: false,
  })
  const inboxAfterLoss = await request(url + '/inbox', auth)
  const rowsAfterLoss = inboxAfterLoss.status === 200 ? JSON.parse(inboxAfterLoss.content)?.data : undefined
  if (!Array.isArray(rowsAfterLoss) || rowsAfterLoss.length !== 2 ||
      rowsAfterLoss.filter(item => item.id === lostID && item.payload?.text === 'TEST-once-after-lost-ack').length !== 1)
    throw Error('native_lost_ack_not_reconciled_by_original_id')
  const cancelLost = await request(url + '/inbox/' + encodeURIComponent(lostID), auth,
    { method: 'DELETE' })
  if (cancelLost.status !== 204) throw Error('native_lost_ack_inbox_cleanup_failed')
  const queueAfterLoss = await request(url + '/inbox', auth)
  const originalOnly = queueAfterLoss.status === 200 ? JSON.parse(queueAfterLoss.content)?.data : undefined
  if (!Array.isArray(originalOnly) || originalOnly.length !== 1 || originalOnly[0]?.id !== inboxID)
    throw Error('native_lost_ack_cleanup_mutated_original')
  receipt.lostAcknowledgement = { ...lostAck, readbackCount: 1, retryPOSTCount: 0,
    cancelled: cancelLost.status }
  receipt.steps.push('native_TEST_lost_ack_readback_without_replay')
  // Close the first TEST-owned process while preserving its private HOME/XDG store.
  await closeOwnServer()
  if (!receipt.cleanup) throw Error('native_pre_restart_stop_unconfirmed')
  child = undefined
  receipt.steps.push('native_TEST_cold_stop_confirmed')

  // One replacement native process, new loopback port, same private persistence.
  receipt.cleanup = false
  const restartPort = await freePort()
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(restartPort)], {
    cwd: directory, env, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
  })
  if (!child.pid) throw Error('native_restart_process_not_started')
  await once(child, 'spawn')
  const restartedDigest = hash(readFileSync(`/proc/${child.pid}/exe`))
  if (restartedDigest !== receipt.binarySha256) throw Error('native_restart_executable_digest_mismatch')
  const restoredEndpoint = `http://127.0.0.1:${restartPort}`
  await readNativeServerInfo(restoredEndpoint, auth, child.pid)
  receipt.restart = { executableSha256: restartedDigest, version, pidMatchesNewProcess: true }
  receipt.steps.push('native_TEST_cold_restart_identity')

  const restoredURL = restoredEndpoint + '/api/session/' + encodeURIComponent(id)
  const restored = await request(restoredURL, auth)
  if (restored.status !== 200) throw Error('native_cold_session_not_restored_' + restored.status)
  const restoredData = JSON.parse(restored.content)?.data
  if (restoredData?.id !== id || restoredData?.location?.directory !== directory ||
      !matchesPermissions(restoredData?.permissions))
    throw Error('native_cold_session_identity_mismatch')
  receipt.steps.push('native_TEST_session_survived_cold_restart')
  receipt.steps.push('native_TEST_ordered_permission_rules_retained')
  const pendingRestart = await request(restoredURL + '/permission', auth)
  if (pendingRestart.status !== 200 ||
      !Array.isArray(JSON.parse(pendingRestart.content)?.data) ||
      JSON.parse(pendingRestart.content).data.length !== 0)
    throw Error('native_pending_permissions_after_restart')
  receipt.permissionRejection = { pendingBefore: 0, staleRead: staleRead.status,
    staleReply: staleReply.status, pendingAfterRestart: 0 }
  receipt.steps.push('native_TEST_no_stale_permission_after_restart')
  const restoredInbox = await request(restoredURL + '/inbox', auth)
  const restoredItems = restoredInbox.status === 200 ? JSON.parse(restoredInbox.content)?.data : undefined
  if (!Array.isArray(restoredItems) || restoredItems.length !== 1 ||
      restoredItems[0]?.id !== inboxID || restoredItems[0]?.payload?.text !== synthetic.text)
    throw Error('native_synthetic_inbox_lost_on_restart')
  receipt.steps.push('native_TEST_synthetic_inbox_survived_cold_restart')
  const replayAfterRestart = await request(restoredURL + '/synthetic', auth, {
    method: 'POST', timeoutMs: 12000, body: { ...synthetic, text: 'TEST-replay-after-cold-restart-ignored' },
  })
  const restoredFirstWriter = replayAfterRestart.status === 200 ? JSON.parse(replayAfterRestart.content)?.data : undefined
  if (restoredFirstWriter?.id !== inboxID || restoredFirstWriter?.payload?.text !== synthetic.text)
    throw Error('native_cold_replay_replaced_admitted_input')
  const checkQueueAfterReplay = await request(restoredURL + '/inbox', auth)
  const queueAfterReplay = checkQueueAfterReplay.status === 200 ? JSON.parse(checkQueueAfterReplay.content)?.data : undefined
  if (!Array.isArray(queueAfterReplay) || queueAfterReplay.length !== 1 ||
      queueAfterReplay[0]?.id !== inboxID || queueAfterReplay[0]?.payload?.text !== synthetic.text)
    throw Error('native_cold_replay_duplicated_inbox')
  receipt.steps.push('native_TEST_first_writer_retained_after_cold_replay')
  const cancelled = await request(restoredURL + '/inbox/' + encodeURIComponent(inboxID), auth,
    { method: 'DELETE' })
  if (cancelled.status !== 204) throw Error('native_synthetic_inbox_cancel_failed')
  const empty = await request(restoredURL + '/inbox', auth)
  if (empty.status !== 200 || !Array.isArray(JSON.parse(empty.content)?.data) ||
      JSON.parse(empty.content).data.length !== 0)
    throw Error('native_synthetic_inbox_not_cleared')
  receipt.syntheticInbox = { created: admitted.status, idempotentRepeat: repeated.status,
    changedReplay: changedDuplicate.status, replayAfterRestart: replayAfterRestart.status,
    persistedItems: 1, cancel: cancelled.status, remaining: 0 }
  receipt.steps.push('native_TEST_synthetic_inbox_cancelled')

  const removed = await request(restoredURL, auth, { method: 'DELETE', timeoutMs: 12000 })
  if (removed.status !== 204) throw Error('native_session_delete_status_' + removed.status)
  receipt.steps.push('native_TEST_session_removed')
  const missing = await request(restoredURL, auth)
  if (missing.status !== 404) throw Error('native_session_post_delete_visible')
  receipt.sessionLifecycle = { created: created.status, read: read.status,
    restored: restored.status, deleted: removed.status, absent: missing.status, idPrefix: 'ses_' }
  receipt.steps.push('native_TEST_session_absence_verified')
  // No provider prompt, external files, model credentials, permission grant, or production admission.
} catch (error) {
  failed = true
  receipt.failure = String(error instanceof Error ? error.message : error)
} finally {
  try { await closeOwnServer() } catch (error) {
    failed = true; receipt.cleanupFailure = String(error instanceof Error ? error.message : error)
  }
  try { rmSync(root, { recursive: true, force: true }) } catch (error) {
    failed = true; receipt.testDirectoryCleanupFailure = String(error instanceof Error ? error.message : error)
  }
  receipt.completed = !failed && receipt.cleanup
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ receiptPath, completed: receipt.completed, steps: receipt.steps, failure: receipt.failure, cleanup: receipt.cleanup }))
}
if (!receipt.completed) process.exitCode = 1
