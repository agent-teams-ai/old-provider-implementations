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
import { decodeV2Session } from '../packages/provider-implementations/src/features/provider-session-implementation/adapters/opencode-protocol/v2-cut-codecs.ts'

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
let ownedStartTicks
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
// Linux /proc/PID/stat field 22 is process start time (clock ticks). Detached
// children must also own their own process-group and session IDs. PID alone
// is not a safe signal authority: it can be reused after a process exits.
function nativeProcessStartTicks(pid) {
  let stat
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const endCommand = stat.lastIndexOf(') ')
  if (endCommand < 0) throw Error('invalid_native_proc_stat')
  const fields = stat.slice(endCommand + 2).trim().split(/\s+/)
  const ticks = fields[19]
  if (!/^\d+$/.test(ticks ?? '') || Number(fields[2]) !== pid || Number(fields[3]) !== pid)
    throw Error('native_process_not_owned_detached_group')
  return ticks
}
function processOrGroupPresent(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function closeOwnServer() {
  if (!child?.pid) return
  const pid = child.pid
  const observedStart = nativeProcessStartTicks(pid)
  if (!observedStart || observedStart !== ownedStartTicks) {
    if (observedStart === null && !processOrGroupPresent(pid) && !processOrGroupPresent(-pid)) {
      receipt.cleanup = true
      return
    }
    // Never signal a PID or process group after losing the original identity.
    throw Error('native_process_start_identity_changed_before_stop')
  }
  try { process.kill(-pid, 'SIGTERM') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  for (let i = 0; i < 20; i++) {
    if (!processOrGroupPresent(pid) && !processOrGroupPresent(-pid)) {
      receipt.cleanup = true
      return
    }
    await delay(100)
  }
  // A vanished group leader cannot authorize a subsequent group-wide SIGKILL.
  if (!processOrGroupPresent(pid) || nativeProcessStartTicks(pid) !== ownedStartTicks)
    throw Error('native_process_group_outlived_verified_owner')
  try { process.kill(-pid, 'SIGKILL') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  for (let i = 0; i < 10; i++) {
    if (!processOrGroupPresent(pid) && !processOrGroupPresent(-pid)) {
      receipt.cleanup = true
      return
    }
    await delay(100)
  }
  throw Error('native_owned_process_group_cleanup_unconfirmed')
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
  ownedStartTicks = nativeProcessStartTicks(child.pid)
  if (!ownedStartTicks) throw Error('native_owned_process_start_unavailable')
  receipt.ownedProcessStartTicks = ownedStartTicks
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
  // Qualify the actual production V2 session decoder against a native response.
  // A separate model-bound TEST session is persisted but never resumed/inferred.
  const testAgent = 'build', testModel = { providerID: 'TEST-provider', id: 'TEST-model' }
  const boundCreate = await request(endpoint + '/api/session', auth, { method: 'POST',
    timeoutMs: 12000, body: { location: { directory }, agent: testAgent,
      model: testModel, permissions: testPermissions },
  })
  if (boundCreate.status !== 200) throw Error('native_bound_session_create_status_' + boundCreate.status)
  const boundData = JSON.parse(boundCreate.content)?.data
  const boundID = boundData?.id
  if (typeof boundID !== 'string' || !/^ses_[A-Za-z0-9_-]+$/.test(boundID) || boundID === id)
    throw Error('native_bound_session_create_identity')
  const boundURL = endpoint + '/api/session/' + encodeURIComponent(boundID)
  const boundRead = await request(boundURL, auth)
  if (boundRead.status !== 200) throw Error('native_bound_session_read_status_' + boundRead.status)
  const codecValue = decodeV2Session(JSON.parse(boundRead.content), boundID, directory)
  if (codecValue.id !== boundID || codecValue.directory !== directory ||
      codecValue.agent !== testAgent || codecValue.model.providerID !== testModel.providerID ||
      codecValue.model.id !== testModel.id || !Number.isSafeInteger(codecValue.timeCreated))
    throw Error('native_production_codec_mismatch')
  const boundDelete = await request(boundURL, auth, { method: 'DELETE', timeoutMs: 12000 })
  if (boundDelete.status !== 204) throw Error('native_bound_session_delete_failed')
  receipt.nativeDriverSessionCodec = { accepted: boundCreate.status, read: boundRead.status,
    deleted: boundDelete.status, decodedModel: true, decodedAgent: true }
  receipt.steps.push('native_TEST_production_V2_session_codec_bound')

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
  // V2 permission rules use last-match-wins, unlike V1's grouped permission
  // object. Exercise the *native* resolver with opposite rule orders; merely
  // reading back a stored array is not proof that the engine enforces it.
  // All resources and sessions live in this isolated TEST prefix. These direct
  // Permission.Service calls do not execute tools or send a model prompt.
  const nativeRuleResults = []
  const testExternalResource = join(root, 'temp', 'TEST-external-resource')
  for (const scenario of [
    { name: 'allow_then_deny', first: 'allow', last: 'deny', expected: 'deny' },
    { name: 'deny_then_allow', first: 'deny', last: 'allow', expected: 'allow' },
    { name: 'allow_then_ask', first: 'allow', last: 'ask', expected: 'ask' },
  ]) {
    const orderedRules = [
      { action: 'external_directory', resource: '*', effect: scenario.first },
      { action: 'external_directory', resource: '*', effect: scenario.last },
    ]
    const made = await request(endpoint + '/api/session', auth, {
      method: 'POST', timeoutMs: 12000,
      body: { location: { directory }, permissions: orderedRules },
    })
    const data = made.status === 200 ? JSON.parse(made.content)?.data : undefined
    if (typeof data?.id !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(data.id) ||
        JSON.stringify(data.permissions) !== JSON.stringify(orderedRules))
      throw Error('native_ordered_rule_session_not_preserved_' + scenario.name)
    const ruleURL = endpoint + '/api/session/' + encodeURIComponent(data.id)
    const evaluation = await request(ruleURL + '/permission', auth, {
      method: 'POST', body: { action: 'external_directory', resources: [testExternalResource] },
    })
    const evaluated = evaluation.status === 200 ? JSON.parse(evaluation.content)?.data : undefined
    if (evaluated?.effect !== scenario.expected)
      throw Error('native_last_matching_rule_not_effective_' + scenario.name)
    const pendingResponse = await request(ruleURL + '/permission', auth)
    const pendingRules = pendingResponse.status === 200 ? JSON.parse(pendingResponse.content)?.data : undefined
    if (!Array.isArray(pendingRules) ||
        pendingRules.length !== (scenario.expected === 'ask' ? 1 : 0))
      throw Error('native_ordered_rule_pending_mismatch_' + scenario.name)
    if (scenario.expected === 'ask') {
      const pendingId = pendingRules[0]?.id
      if (typeof pendingId !== 'string' || !/^per[A-Za-z0-9_-]+$/.test(pendingId) ||
          pendingRules[0]?.sessionID !== data.id || evaluated?.id !== pendingId)
        throw Error('native_ordered_rule_ask_identity_mismatch')
      const rejectedRule = await request(ruleURL + '/permission/' + encodeURIComponent(pendingId) + '/reply',
        auth, { method: 'POST', body: { decision: 'reject' } })
      if (rejectedRule.status !== 204)
        throw Error('native_ordered_rule_ask_reject_failed')
      const afterReject = await request(ruleURL + '/permission', auth)
      if (afterReject.status !== 200 || JSON.parse(afterReject.content)?.data?.length !== 0)
        throw Error('native_ordered_rule_ask_not_cleared')
    }
    const deletedRule = await request(ruleURL, auth, { method: 'DELETE' })
    if (deletedRule.status !== 204) throw Error('native_ordered_rule_session_not_deleted')
    nativeRuleResults.push({ order: scenario.name, result: scenario.expected, pendingClean: true })
  }
  receipt.nativeRuleOrdering = nativeRuleResults
  receipt.steps.push('native_TEST_last_matching_rule_allow_deny_ask_evaluated')
  // Pinned V2.0.21 Session.log is an SSE read of session events filtered from
  // a shared durable bus; never require contiguous visible sequence numbers.
  const nativeLogPath = '/api/experimental/session/' + encodeURIComponent(id) + '/log?follow=false'
  const logResponse = await request(endpoint + nativeLogPath, auth, { timeoutMs: 12000 })
  if (logResponse.status !== 200 || !logResponse.contentType?.startsWith('text/event-stream'))
    throw Error('native_session_log_unavailable')
  const logFrames = logResponse.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n\n').flatMap(frame => {
      const data = frame.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n')
      return data ? [JSON.parse(data)] : []
    })
  const syncedLog = logFrames.at(-1)
  const nativeEvents = logFrames.slice(0, -1)
  // Bounded, TEST-only diagnostics: expose event kinds and routing, never payloads.
  receipt.nativeLogDiagnostic = { status: logResponse.status,
    contentType: logResponse.contentType, frameTypes: logFrames.slice(0, 24).map(item => item?.type ?? null),
    frameCount: logFrames.length, syncedType: syncedLog?.type ?? null,
    syncedOwnerMatches: syncedLog?.aggregateID === id,
    firstType: nativeEvents[0]?.type ?? null }
  // Real native v2.0.21 has only an owned log.synced frame before any model
  // execution; session creation does not guarantee session.created in this log.
  // Accept that as TEST-only discovery, not as a readable turn/native history.
  if (syncedLog?.type !== 'log.synced' || syncedLog.aggregateID !== id ||
      (nativeEvents.length > 0 && nativeEvents[0]?.type !== 'session.created'))
    throw Error('native_session_log_missing_prefix_or_sync')
  let lastVisibleSeq = -1
  let observedGaps = 0
  for (const event of nativeEvents) {
    const seq = event?.durable?.seq
    if (event?.durable?.aggregateID !== id || typeof event?.type !== 'string' ||
        !event.type.startsWith('session.') || !Number.isSafeInteger(seq) ||
        seq <= lastVisibleSeq || event?.data?.sessionID !== id)
      throw Error('native_session_log_invalid_event_identity')
    if (lastVisibleSeq >= 0 && seq > lastVisibleSeq + 1) observedGaps++
    lastVisibleSeq = seq
  }
  if (!Number.isSafeInteger(syncedLog.seq) || syncedLog.seq < lastVisibleSeq)
    throw Error('native_session_log_invalid_sync_watermark')
  receipt.nativeSessionLog = { visibleEvents: nativeEvents.length, lastVisibleSeq,
    syncedWatermark: syncedLog.seq, observedFilteredGaps: observedGaps }
  receipt.steps.push(nativeEvents.length === 0
    ? 'native_TEST_preexecution_empty_SSE_with_owned_sync'
    : 'native_TEST_pinned_SSE_session_log_verified')
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
  // Diagnose native durable-log visibility after a real, model-free inbox mutation.
  // Do not infer session history from a successful inbox write.
  const queuedLog = await request(endpoint + nativeLogPath, auth, { timeoutMs: 12000 })
  if (queuedLog.status !== 200 || !queuedLog.contentType?.startsWith('text/event-stream'))
    throw Error('native_post_enqueue_log_unavailable')
  const queuedFrames = queuedLog.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n\n').flatMap(frame => {
      const data = frame.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n')
      return data ? [JSON.parse(data)] : []
    })
  const queuedSynced = queuedFrames.at(-1)
  if (queuedSynced?.type !== 'log.synced' || queuedSynced.aggregateID !== id ||
      !Number.isSafeInteger(queuedSynced.seq) || queuedSynced.seq < syncedLog.seq)
    throw Error('native_post_enqueue_log_sync_invalid')
  const queuedVisible = queuedFrames.slice(0, -1)
  if (queuedVisible.some(item => item?.durable?.aggregateID !== id ||
      item?.data?.sessionID !== id || typeof item.type !== 'string' ||
      !item.type.startsWith('session.') || !Number.isSafeInteger(item?.durable?.seq)))
    throw Error('native_post_enqueue_log_foreign_event')
  receipt.nativePostEnqueueLog = { visibleTypes: queuedVisible.map(item => item.type).slice(0, 64),
    visibleCount: queuedVisible.length, syncedWatermark: queuedSynced.seq,
    initialSyncedWatermark: syncedLog.seq }
  receipt.steps.push('native_TEST_post_enqueue_SSE_visibility_captured')
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
  ownedStartTicks = nativeProcessStartTicks(child.pid)
  if (!ownedStartTicks) throw Error('native_restart_start_unavailable')
  const restartedDigest = hash(readFileSync(`/proc/${child.pid}/exe`))
  if (restartedDigest !== receipt.binarySha256) throw Error('native_restart_executable_digest_mismatch')
  const restoredEndpoint = `http://127.0.0.1:${restartPort}`
  await readNativeServerInfo(restoredEndpoint, auth, child.pid)
  receipt.restart = { executableSha256: restartedDigest, version, pidMatchesNewProcess: true,
    ownedProcessStartTicks: ownedStartTicks }
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
  // Unauthenticated observers must not inspect or cancel restored queued work.
  const unauthInboxRead = await request(restoredURL + '/inbox')
  const unauthInboxDelete = await request(restoredURL + '/inbox/' + encodeURIComponent(inboxID),
    undefined, { method: 'DELETE' })
  if (unauthInboxRead.status !== 401 || unauthInboxDelete.status !== 401)
    throw Error('native_restored_inbox_auth_bypass')
  const afterUnauth = await request(restoredURL + '/inbox', auth)
  const afterUnauthRows = afterUnauth.status === 200 ? JSON.parse(afterUnauth.content)?.data : undefined
  if (!Array.isArray(afterUnauthRows) || afterUnauthRows.length !== 1 ||
      afterUnauthRows[0]?.id !== inboxID || afterUnauthRows[0]?.payload?.text !== synthetic.text)
    throw Error('native_unauthorized_inbox_mutation')
  receipt.steps.push('native_TEST_restored_inbox_authz_denials')
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
  // A different session must still be unable to adopt this durable ID after restart.
  const coldOther = await request(restoredEndpoint + '/api/session', auth, { method: 'POST',
    timeoutMs: 12000, body: { location: { directory }, permissions: testPermissions } })
  const coldOtherID = coldOther.status === 200 ? JSON.parse(coldOther.content)?.data?.id : undefined
  if (typeof coldOtherID !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(coldOtherID) ||
      coldOtherID === id || coldOtherID === otherID)
    throw Error('native_cold_foreign_session_identity')
  const coldOtherURL = restoredEndpoint + '/api/session/' + encodeURIComponent(coldOtherID)
  const coldCollision = await request(coldOtherURL + '/synthetic', auth, { method: 'POST',
    timeoutMs: 12000, body: { ...synthetic, text: 'TEST-cold-foreign-collision' } })
  const coldOtherInbox = await request(coldOtherURL + '/inbox', auth)
  const coldOtherRows = coldOtherInbox.status === 200 ? JSON.parse(coldOtherInbox.content)?.data : undefined
  if (coldCollision.status !== 409 || !Array.isArray(coldOtherRows) || coldOtherRows.length !== 0)
    throw Error('native_cold_cross_session_id_adoption')
  const coldOtherRemoved = await request(coldOtherURL, auth,
    { method: 'DELETE', timeoutMs: 12000 })
  if (coldOtherRemoved.status !== 204) throw Error('native_cold_foreign_cleanup_failed')
  receipt.steps.push('native_TEST_foreign_id_rejected_after_cold_restart')
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
  // A real V2 user prompt with resume:false performs durable input admission only.
  // No provider/model request, tool execution, or implicit replay is permitted.
  const promptID = 'msg_TESTnativePromptNoModel'
  const promptRequest = { id: promptID, text: 'TEST-native-prompt-inbox-no-model',
    delivery: 'queue', resume: false }
  const promptAck = await request(restoredURL + '/prompt', auth, {
    method: 'POST', timeoutMs: 12000, body: promptRequest,
  })
  const promptData = promptAck.status === 200 ? JSON.parse(promptAck.content)?.data : undefined
  if (promptData?.id !== promptID || promptData?.sessionID !== id ||
      promptData?.type !== 'user' || promptData?.payload?.text !== promptRequest.text ||
      promptData?.delivery !== 'queue')
    throw Error('native_model_free_prompt_receipt_mismatch')
  const promptInbox = await request(restoredURL + '/inbox', auth)
  const promptItems = promptInbox.status === 200 ? JSON.parse(promptInbox.content)?.data : undefined
  if (!Array.isArray(promptItems) || promptItems.length !== 1 ||
      promptItems[0]?.id !== promptID || promptItems[0]?.type !== 'user' ||
      promptItems[0]?.payload?.text !== promptRequest.text)
    throw Error('native_model_free_prompt_not_durable')
  const promptCancelled = await request(restoredURL + '/inbox/' + encodeURIComponent(promptID),
    auth, { method: 'DELETE' })
  if (promptCancelled.status !== 204) throw Error('native_model_free_prompt_cancel_failed')
  const promptEmpty = await request(restoredURL + '/inbox', auth)
  if (promptEmpty.status !== 200 || JSON.parse(promptEmpty.content)?.data?.length !== 0)
    throw Error('native_model_free_prompt_not_cleared')
  receipt.nativePromptAdmission = { accepted: promptAck.status, queueItems: 1,
    cancelled: promptCancelled.status, remaining: 0, modelTurn: false }
  receipt.steps.push('native_TEST_prompt_admit_and_cancel_without_model')
  // The actual V2 user-prompt route may commit before its HTTP acknowledgement is lost.
  // Recover by original ID from durable inbox; never submit the user prompt again.
  const lostPromptID = 'msg_TESTnativePromptLostAck'
  const lostPromptText = 'TEST-native-prompt-committed-lost-ack'
  const lostPrompt = await submitWithLostAck(restoredURL + '/prompt', auth, {
    id: lostPromptID, text: lostPromptText, delivery: 'queue', resume: false,
  })
  const readAfterLostPrompt = await request(restoredURL + '/inbox', auth)
  const lostPromptRows = readAfterLostPrompt.status === 200
    ? JSON.parse(readAfterLostPrompt.content)?.data : undefined
  if (!Array.isArray(lostPromptRows) || lostPromptRows.length !== 1 ||
      lostPromptRows[0]?.id !== lostPromptID || lostPromptRows[0]?.type !== 'user' ||
      lostPromptRows[0]?.payload?.text !== lostPromptText)
    throw Error('native_lost_prompt_ack_not_reconciled')
  const cancelledLostPrompt = await request(restoredURL + '/inbox/' +
    encodeURIComponent(lostPromptID), auth, { method: 'DELETE' })
  if (cancelledLostPrompt.status !== 204) throw Error('native_lost_prompt_ack_cancel_failed')
  const afterCancelLostPrompt = await request(restoredURL + '/inbox', auth)
  if (afterCancelLostPrompt.status !== 200 ||
      JSON.parse(afterCancelLostPrompt.content)?.data?.length !== 0)
    throw Error('native_lost_prompt_ack_inbox_not_empty')
  receipt.nativeLostPromptAck = { ...lostPrompt, readbackCount: 1, retryPOSTCount: 0,
    cancelled: cancelledLostPrompt.status, remaining: 0 }
  receipt.steps.push('native_TEST_user_prompt_lost_ack_reconciled_without_replay')

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
