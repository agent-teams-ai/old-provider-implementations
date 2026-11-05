// TEST-only binary discovery. Not a production Host launch and not a native V01 certificate.
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
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
