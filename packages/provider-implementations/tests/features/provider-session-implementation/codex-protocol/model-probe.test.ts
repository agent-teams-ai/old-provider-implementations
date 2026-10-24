import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { probeCodexModel, codexModelOptionArgs, type CodexModelProbeConfig } from '../../../../src/codex.ts'
import { fixture } from './subprocess-fixture.ts'

async function setup(t: TestContext) {
  const native = await fixture(t)
  await native.command({ kind: 'metadata', method: 'thread/start', response: {
    thread: { id: 'TEST-thread' }, model: 'TEST-model', modelProvider: 'TEST-provider', cwd: '/TEST-workspace',
  } })
  await native.command({ kind: 'metadata', method: 'initialize', response: { codexHome: '/TEST-config', platformFamily: 'unix', platformOs: process.platform } })
  let launchArgs: readonly string[] = []
  let current = true, launches = 0, disposals = 0, cleaned = true
  const config: { -readonly [K in keyof CodexModelProbeConfig]: CodexModelProbeConfig[K] } = { cwd: '/TEST-workspace', executablePath: '/TEST-codex',
    environment: { HOME: '/TEST-home', PATH: '/TEST-bin', CODEX_HOME: '/TEST-config' },
    model: 'TEST-model', modelProvider: 'TEST-provider', timeoutMs: 2000, canSubmit: () => current,
    launch(request) {
      launches++
      assert.equal(request.command, '/TEST-codex')
      launchArgs = request.args
      assert.equal(request.cwd, '/TEST-workspace')
      assert.deepEqual(request.env, { HOME: '/TEST-home', PATH: '/TEST-bin', CODEX_HOME: '/TEST-config' })
      return { transport: native.transport, async dispose() { disposals++; current = false; return cleaned } }
    },
  }
  const started = () => native.waitFor(row => (row.message as Record<string, unknown> | undefined)?.method === 'turn/start')
  const finish = async (text = 'OK', status = 'completed') => {
    if (text) {await native.command({ kind: 'notify', method: 'item/completed', params: { threadId: 'TEST-thread', turnId: 'turn-1', item: { id: 'TEST-text', type: 'agentMessage', text } } })}
    await native.command({ kind: 'finish', threadId: 'TEST-thread', turnId: 'turn-1', status })
  }
  return { native, config, started, finish, launchArgs: () => launchArgs, revoke() { current = false }, failCleanup() { cleaned = false }, counts: () => ({ launches, disposals }) }
}

test('finite probe uses selected child/model and no-tools output; own disposal seals custody without erasing success', async t => {
  const s = await setup(t)
  const pending = probeCodexModel(s.config)
  await s.started()
  s.config.model = 'mutated'; s.config.environment.HOME = '/foreign'
  await s.finish()
  assert.equal(await pending, true)
  assert.deepEqual(s.counts(), { launches: 1, disposals: 1 })
  const params = s.native.writes.find(row => row.method === 'thread/start')?.params as Record<string, unknown>
  assert.equal(params.model, 'TEST-model'); assert.equal(params.sandbox, 'read-only'); assert.equal(params.approvalPolicy, 'never')
  assert.equal(s.native.writes.filter(row => row.method === 'turn/start').length, 1)
})

test('native model/provider/cwd mismatch refuses inference rather than guessing or retrying', async t => {
  for (const delta of [{ model: 'foreign' }, { modelProvider: 'foreign' }, { cwd: '/foreign' }, { model: null }]) {
    const s = await setup(t)
    await s.native.command({ kind: 'metadata', method: 'thread/start', response: { thread: { id: 'TEST-thread' }, model: 'TEST-model', modelProvider: 'TEST-provider', cwd: '/TEST-workspace', ...delta } })
    assert.equal(await probeCodexModel(s.config), false)
    assert.equal(s.native.writes.some(row => row.method === 'turn/start'), false)
    assert.deepEqual(s.counts(), { launches: 1, disposals: 1 })
  }
})

test('absent selected provider stays absent and is proven by native thread selection', async t => {
  const s = await setup(t); delete s.config.modelProvider
  const pending = probeCodexModel(s.config); await s.started(); await s.finish()
  assert.equal(await pending, true)
  assert.equal(Object.hasOwn(s.native.writes.find(row => row.method === 'thread/start')?.params as object, 'modelProvider'), false)
})

test('empty output and failed terminal are not inference success', async t => {
  for (const [text, status] of [['', 'completed'], ['OK', 'failed']]) {
    const s = await setup(t); const pending = probeCodexModel(s.config)
    await s.started(); await s.finish(text, status)
    assert.equal(await pending, false)
    assert.equal(s.counts().disposals, 1)
  }
})

test('native tool items and unknown native control attempts disqualify otherwise successful text', async t => {
  for (const control of [false, true]) {
    const s = await setup(t); const pending = probeCodexModel(s.config); await s.started()
    if (control) {
      await s.native.command({ kind: 'approval', requestId: 'TEST-request', method: 'TEST/unknown', params: { threadId: 'TEST-thread', turnId: 'turn-1' } })
      await s.native.waitFor(row => row.event === 'wire' && (row.message as Record<string, unknown> | undefined)?.id === 'TEST-request')
    } else {
      await s.native.command({ kind: 'notify', method: 'item/started', params: { threadId: 'TEST-thread', turnId: 'turn-1', item: { id: 'TEST-tool', type: 'commandExecution', command: 'TEST' } } })
    }
    await s.finish(); assert.equal(await pending, false)
  }
})

test('preallocation refusal, cancelled pending wire and finite timeout never replay and clean captured child', async t => {
  const refused = await setup(t); refused.revoke()
  await assert.rejects(probeCodexModel(refused.config), /codex.probe.cancelled/u)
  assert.deepEqual(refused.counts(), { launches: 0, disposals: 0 })
  const s = await setup(t), blocked = s.native.blockNextWrite(), abort = new AbortController()
  const pending = probeCodexModel(s.config, abort.signal)
  const rejection = assert.rejects(pending, /codex.probe.cancelled/u)
  await blocked.started; abort.abort(); blocked.release(); await rejection
  assert.equal(s.native.writes.some(row => row.method === 'turn/start'), false)
  assert.equal(s.counts().disposals, 1)
  const timed = await setup(t); timed.config.timeoutMs = 60
  await assert.rejects(probeCodexModel(timed.config), /codex.probe.timeout/u)
  assert.equal(timed.counts().disposals, 1)
})

test('unconfirmed captured-child cleanup overrides successful native result; caller exceptions are redacted', async t => {
  const s = await setup(t); s.failCleanup()
  const pending = probeCodexModel(s.config), rejection = assert.rejects(pending, /codex.probe.cleanup-unconfirmed/u)
  await s.started(); await s.finish(); await rejection
  const bad = await setup(t); bad.config.launch = () => { throw new Error('TEST-private-secret') }
  await assert.rejects(probeCodexModel(bad.config), error => error instanceof Error && error.message === 'codex.probe.unavailable')
})

test('wrong native namespace refuses thread allocation', async t => {
  const s = await setup(t)
  await s.native.command({ kind: 'metadata', method: 'initialize', response: { codexHome: '/foreign', platformFamily: 'unix', platformOs: process.platform } })
  await assert.rejects(probeCodexModel(s.config), /codex.probe.namespace-mismatch/u)
  assert.equal(s.native.writes.some(row => row.method === 'thread/start'), false)
  assert.equal(s.counts().disposals, 1)
})

test('lost native terminal remains unknown and revoked original custody cannot report success', async t => {
  const lost = await setup(t), pending = probeCodexModel(lost.config)
  const rejection = assert.rejects(pending, /codex.probe.unknown/u)
  await lost.started(); await lost.native.command({ kind: 'disconnect' }); await rejection
  assert.deepEqual(lost.counts(), { launches: 1, disposals: 1 })
  const revoked = await setup(t), stale = probeCodexModel(revoked.config)
  const refused = assert.rejects(stale, /codex.probe.cancelled/u)
  await revoked.started(); revoked.revoke(); await revoked.finish(); await refused
  assert.deepEqual(revoked.counts(), { launches: 1, disposals: 1 })
})

// These are actual native CLI TOML flags, not a second translation in the Host.
test('native model option arguments preserve extensible catalog effort and true-only Fast settings', () => {
  assert.deepEqual(codexModelOptionArgs({}), [])
  assert.deepEqual(codexModelOptionArgs({ fastMode: false }), [])
  assert.deepEqual(codexModelOptionArgs({ reasoningEffort: 'none', fastMode: true }), [
    '-c', 'model_reasoning_effort="none"', '-c', 'service_tier="fast"', '-c', 'features.fast_mode=true',
  ])
  assert.deepEqual(codexModelOptionArgs({ reasoningEffort: 'future-native-value' }), ['-c', 'model_reasoning_effort="future-native-value"'])
  assert.throws(() => codexModelOptionArgs({ reasoningEffort: 'bad\nvalue' }), /codex.options.invalid-config/u)
})

test('finite inference proves captured effort and Fast tier before its only input and keeps native turn effort', async t => {
  const s = await setup(t)
  s.config.reasoningEffort = 'ultra'; s.config.fastMode = true
  await s.native.command({ kind: 'metadata', method: 'thread/start', response: { thread: { id: 'TEST-thread' }, model: 'TEST-model', modelProvider: 'TEST-provider', cwd: '/TEST-workspace', reasoningEffort: 'ultra', serviceTier: 'fast' } })
  const pending = probeCodexModel(s.config); await s.started()
  s.config.reasoningEffort = 'low'; s.config.fastMode = false
  assert.deepEqual(s.launchArgs(), ['-c', 'model_reasoning_effort="ultra"', '-c', 'service_tier="fast"', '-c', 'features.fast_mode=true', 'app-server', '--listen', 'stdio://'])
  const turn = s.native.writes.find(row => row.method === 'turn/start'); assert.ok(turn)
  assert.equal((turn.params as Record<string, unknown>).effort, 'ultra')
  await s.finish(); assert.equal(await pending, true)
})

test('native effort/tier mismatch cannot run a default-model probe in place of selected options', async t => {
  for (const proof of [{ reasoningEffort: 'low', serviceTier: 'fast' }, { reasoningEffort: 'ultra', serviceTier: null }, {}]) {
    const s = await setup(t); s.config.reasoningEffort = 'ultra'; s.config.fastMode = true
    await s.native.command({ kind: 'metadata', method: 'thread/start', response: { thread: { id: 'TEST-thread' }, model: 'TEST-model', modelProvider: 'TEST-provider', cwd: '/TEST-workspace', ...proof } })
    assert.equal(await probeCodexModel(s.config), false)
    assert.equal(s.native.writes.some(row => row.method === 'turn/start'), false)
  }
  const inherited = await setup(t); inherited.config.fastMode = false
  await inherited.native.command({ kind: 'metadata', method: 'thread/start', response: { thread: { id: 'TEST-thread' }, model: 'TEST-model', modelProvider: 'TEST-provider', cwd: '/TEST-workspace', serviceTier: 'fast', reasoningEffort: 'high' } })
  const pending = probeCodexModel(inherited.config); await inherited.started(); await inherited.finish()
  assert.equal(await pending, true)
  assert.deepEqual(inherited.launchArgs(), ['app-server', '--listen', 'stdio://'])
  assert.equal(Object.hasOwn(inherited.native.writes.find(row => row.method === 'turn/start')?.params as object, 'effort'), false)
})
