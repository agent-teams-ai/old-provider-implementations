// TEST-only native model binding discovery; no prompt or real model call.
import { createHash, randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
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
let native, fake
let failed = false
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const version = '2.0.21'
const expectedDigest = 'f916986543348d7953d8d43aa048516cdbc3f84f4d0dc9c0c5b9d1da3030cea7'

async function request(url, authorization, operation = {}) {
  const response = await fetch(url, {
    method: operation.method || 'GET',
    redirect: 'error',
    headers: authorization ? { authorization } : {},
    signal: AbortSignal.timeout(operation.timeoutMs || 2500),
  })
  const body = await response.text()
  if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw Error('TEST_response_too_large')
  return { status: response.status, json: JSON.parse(body) }
}
async function closeNative() {
  if (!native?.pid) return
  try { process.kill(-native.pid, 'SIGTERM') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  for (let i = 0; i < 30; i++) {
    try { process.kill(native.pid, 0) } catch (error) {
      if (error.code === 'ESRCH') { receipt.cleanup = true; return }
      throw error
    }
    await delay(100)
  }
  try { process.kill(-native.pid, 'SIGKILL') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  await delay(150)
  try { process.kill(native.pid, 0); receipt.cleanup = false }
  catch (error) { if (error.code === 'ESRCH') receipt.cleanup = true; else throw error }
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
  let attemptedInference = 0
  fake = createServer((req, res) => {
    attemptedInference++
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{"error":"TEST_model_turn_not_authorized"}')
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

  const available = await request(endpoint + '/api/model', auth, { timeoutMs: 15000 })
  const preferred = await request(endpoint + '/api/model/default', auth, { timeoutMs: 15000 })
  const items = available.json?.data, selected = preferred.json?.data
  receipt.modelDiscovery = { listStatus: available.status, defaultStatus: preferred.status,
    modelCount: Array.isArray(items) ? items.length : null,
    selectedID: selected?.id ?? null, selectedProvider: selected?.providerID ?? null,
    fakeInferenceRequests: attemptedInference }
  if (available.status !== 200 || preferred.status !== 200 ||
      !Array.isArray(items) ||
      !items.some(item => item.id === modelID && item.providerID === providerID) ||
      selected?.id !== modelID || selected?.providerID !== providerID ||
      attemptedInference !== 0)
    throw Error('TEST_native_local_model_binding_not_qualified')
  receipt.steps.push('TEST_native_local_model_selected_without_inference')
} catch (error) {
  failed = true
  receipt.failure = error instanceof Error ? error.message : String(error)
} finally {
  try { await closeNative() } catch (error) {
    failed = true; receipt.cleanupFailure = String(error)
  }
  if (fake) {
    try {
      fake.closeAllConnections()
      await new Promise((ok, fail) => fake.close(error => error ? fail(error) : ok()))
    } catch (error) { failed = true; receipt.fakeCleanupFailure = String(error) }
  }
  try { rmSync(root, { recursive: true, force: true }) }
  catch (error) { failed = true; receipt.directoryCleanupFailure = String(error) }
  receipt.completed = !failed && receipt.cleanup
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ completed: receipt.completed, steps: receipt.steps, failure: receipt.failure }))
}
if (!receipt.completed) process.exitCode = 1
