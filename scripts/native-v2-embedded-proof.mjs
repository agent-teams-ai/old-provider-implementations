// TEST-only proof of pinned OpenCode V2 embedded durable event retention.
// No native CLI, model execution, user credentials, external provider or production activation.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const receiptPath = resolve(process.env.OPENCODE_V2_EMBEDDED_RECEIPT || 'native-v2-embedded-proof.json')
const prefix = process.env.OPENCODE_V2_EMBEDDED_NPM_PREFIX
const receipt = { kind: 'TEST_V2_EMBEDDED_DURABLE_DISCOVERY_ONLY', qualified: false, steps: [], cleanup: false }
const root = mkdtempSync(join(tmpdir(), 'TEST-v2-embedded-'))
for (const dir of ['workspace', 'home', 'config', 'cache', 'data', 'state', 'temp']) {
  mkdirSync(join(root, dir), { recursive: true })
}
const workspace = join(root, 'workspace'), database = join(root, 'data', 'embedded.sqlite')
let host
let failed = false
// The embedded module must never see user/runner credentials, provider keys or ambient config.
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'LANG', 'TZ'].includes(key)) delete process.env[key]
}
Object.assign(process.env, {
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
  for await (const value of sdk.sessions.log({ sessionID, follow: false })) {
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
  if (!prefix?.startsWith('/')) throw Error('TEST_embedded_prefix_not_absolute')
  const require = createRequire(join(prefix, 'TEST-source-entry.cjs'))
  const entry = require.resolve('@opencode/sdk')
  const { OpenCode } = await import(pathToFileURL(entry).href)
  if (typeof OpenCode?.create !== 'function') throw Error('TEST_embedded_api_unavailable')
  receipt.steps.push('pinned_embedded_SDK_module_resolved')
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
  try { rmSync(root, { recursive: true, force: true }) } catch (error) {
    failed = true; receipt.testDirectoryCleanupFailure = String(error)
  }
  receipt.cleanup = !receipt.hostCleanupFailure && !receipt.testDirectoryCleanupFailure
  receipt.completed = !failed && receipt.cleanup
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ completed: receipt.completed, steps: receipt.steps,
    failure: receipt.failure, cleanup: receipt.cleanup }))
}
if (!receipt.completed) process.exitCode = 1
