// TEST-only binary discovery. Not a production Host launch and not a native V01 certificate.
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const version = '2.0.21'
const receiptPath = resolve(process.env.OPENCODE_V2_TEST_RECEIPT || 'native-v2-readonly-proof.json')
const receipt = { kind: 'TEST_NATIVE_DISCOVERY_ONLY', version, qualified: false, steps: [], cleanup: false }
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
/** The public npm CLI is a Node launcher. Never hash or execute the shim as an engine. */
function discoverSingleNativeBinary(npmRoot) {
  const base = realpathSync(npmRoot)
  const matches = []
  let inspected = 0
  function scan(directory) {
    if (++inspected > 10000) throw Error('native_package_scan_budget')
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { scan(path); continue }
      if (!entry.isFile() || entry.name !== 'opencode') continue
      const bytes = readFileSync(path)
      if (bytes.subarray(0, 4).toString('hex') === '7f454c46') matches.push(path)
    }
  }
  scan(base)
  if (matches.length !== 1) throw Error('native_elf_count_' + matches.length)
  const native = realpathSync(matches[0])
  if (!native.startsWith(base + '/')) throw Error('native_binary_outside_test_prefix')
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
async function request(url, authorization) {
  const response = await fetch(url, {
    method: 'GET', redirect: 'error',
    headers: authorization ? { authorization } : {},
    signal: AbortSignal.timeout(2500),
  })
  const content = await response.text()
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw Error('unbounded_server_response')
  return { status: response.status, content, contentType: response.headers.get('content-type') }
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
  const reported = execFileSync(binary, ['--version'], { cwd: directory, env, encoding: 'utf8', timeout: 12000 }).trim()
  receipt.reportedVersion = reported
  if (reported !== version) throw Error('native_version_mismatch')
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
  let health
  for (let i = 0; i < 80; i++) {
    try { health = await request(endpoint + '/global/health', auth); break } catch { await delay(250) }
  }
  if (!health || health.status !== 200) throw Error(`health_unavailable_${health?.status ?? 'no_response'}`)
  const value = JSON.parse(health.content)
  receipt.health = { healthy: value.healthy, version: value.version }
  if (value.healthy !== true || value.version !== version) throw Error('native_health_version_mismatch')
  receipt.steps.push('authenticated_loopback_native_health')
  const denied = await request(endpoint + '/global/health')
  receipt.unauthenticatedStatus = denied.status
  if (denied.status !== 401) throw Error('loopback_auth_not_enforced')
  receipt.steps.push('unauthenticated_request_rejected')
  const spec = await request(endpoint + '/doc', auth)
  receipt.openapi = { status: spec.status, contentType: spec.contentType, sha256: hash(spec.content) }
  if (spec.status !== 200 || !spec.content.includes('openapi')) throw Error('native_openapi_unavailable')
  receipt.steps.push('native_OpenAPI_retrievable')
  // Important: no session POST, model/credential use, permission reply or production admission.
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
