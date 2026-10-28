import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCodexDriverFactory } from '../../../../src/codex.ts'
import { context, opened, selection, input, ref, until } from './driver-support.ts'

test('canonical capabilities and exact binding reject before any native protocol IO', async t => {
  let resolved = 0
  const factory = createCodexDriverFactory({ capabilities: ['text'], resolveConfiguration: async (): Promise<undefined> => { resolved++; }, readCheckpoint: async () => {} })
  await assert.rejects(factory.open({ ...selection(), requiredCapabilities: ['question'] }), /codex.driver.unsupported/)
  assert.equal(resolved, 0)
  assert.throws(() => createCodexDriverFactory({ capabilities: ['question'], resolveConfiguration: async (): Promise<undefined> => {}, readCheckpoint: async () => {} }), /unsupported/)
  const c = await context(t)
  await assert.rejects(c.factory.open({ ...c.request, tenantId: 'foreign' }), /invalid-config/)
  await assert.rejects(c.factory.open({ ...c.request, checkpointRef: 'missing' }), /checkpoint-missing/)
  c.checkpoint({ version: 1, engine: 'codex-app-server', nativeThreadId: 'foreign', compatibility: 'foreign' })
  await assert.rejects(c.factory.open({ ...c.request, checkpointRef: 'incompatible' }), /checkpoint-incompatible/)
  assert.equal(c.native.writes.length, 0)
})

test('malformed JavaScript Host configuration fails before native IO instead of trusting declared types', async t => {
  const c = await context(t)
  for (const configuration of [null, { ...c.config, binding: null }, { ...c.config, transport: null },
    { ...c.config, limits: { ...c.config.limits, outputEvents: '50' } },
    { ...c.config, initialize: { clientInfo: { name: 'TEST', version: 42 } } },
    { ...c.config, threadParams: { ...c.config.threadParams, threadId: 'foreign' } }]) {
    const factory = createCodexDriverFactory({ ...c.host, resolveConfiguration: async () => configuration as never })
    await assert.rejects(factory.open(c.request), /codex.driver.invalid-config/)
  }
  assert.equal(c.native.writes.length, 0)
})

test('explicit selected restore resumes the checkpoint thread and never falls back when native resume fails', async t => {
  const original = await opened(t)
  await original.driver.submit(input()); await original.native.command({ kind: 'finish', ...ref(original.native) })
  await until(() => original.events.some(event => event.kind === 'result'))
  const checkpoint = original.driver.checkpoint(); assert(checkpoint.ok)
  assert.deepEqual(await original.driver.close(), { logicallyClosed: true, cleanup: 'unknown' })
  const c = await context(t); c.checkpoint(checkpoint.value)
  const restored = await c.factory.open({ ...c.request, checkpointRef: 'selected-reference' }); t.after(() => restored.driver.close())
  assert.equal(c.native.writes.some(frame => frame.method === 'thread/start'), false)
  const params = c.native.writes.find(frame => frame.method === 'thread/resume')?.params as Record<string, unknown>
  assert.equal(params.threadId, 'thread-1')
  const incompatible = await context(t); incompatible.checkpoint(checkpoint.value)
  const factory = createCodexDriverFactory({ ...incompatible.host, resolveConfiguration: async () => ({ ...incompatible.config, accountBinding: 'different-account' }) })
  await assert.rejects(factory.open({ ...incompatible.request, checkpointRef: 'selected-reference' }), /checkpoint-incompatible/)
  assert.equal(incompatible.native.writes.length, 0)
  const missing = await context(t); missing.checkpoint(checkpoint.value)
  await missing.native.command({ kind: 'reject-next-resume' })
  await assert.rejects(missing.factory.open({ ...missing.request, checkpointRef: 'selected-reference' }), /open-failed/)
  assert.equal(missing.native.writes.some(frame => frame.method === 'thread/start'), false)
})

test('configuration is captured before await and native custody cleanup is independently attested', async t => {
  const c = await context(t)
  let release!: () => void
  const probe = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const called = new Promise<void>(resolve => { entered = resolve })
  const factory = createCodexDriverFactory({ ...c.host, resolveConfiguration: async () => ({ ...c.config,
    probe: async () => { entered(); await probe; return true }, confirmStopped: async () => true }) })
  const opening = factory.open(c.request); await called
  ;(c.config.threadParams as Record<string, unknown>).model = 'mutated'
  release(); const { driver } = await opening; t.after(() => driver.close())
  const start = c.native.writes.find(frame => frame.method === 'thread/start'); assert.ok(start)
  assert.equal((start.params as Record<string, unknown>).model, 'TEST-model')
  const closing = driver.close(); assert.equal(closing, driver.close())
  assert.deepEqual(await driver.submit(input()), { ok: false, code: 'unavailable', delivery: 'known-not-sent' })
  assert.deepEqual(await closing, { logicallyClosed: true, cleanup: 'confirmed' })
})
