import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCodexDriverFactory } from '../../../../src/codex.ts'
import { capabilities, context, opened, input, ref, until } from './driver-support.ts'

test('observed terminal remains succeeded when flushing final native text exceeds the canonical output budget', async t => {
  const c = await context(t)
  const { driver } = await createCodexDriverFactory({ ...c.host, resolveConfiguration: async () => ({ ...c.config,
    limits: { ...c.config.limits, outputEvents: 1 }, turnParams: { fixtureEarly: true, fixtureLateThreadStarted: true } }) }).open(c.request)
  t.after(() => driver.close())
  const events: Awaited<ReturnType<typeof opened>>['events'] = []
  const observing = (async () => { for await (const event of driver.observe()) {events.push(event)} })()
  const accepted = await driver.submit(input()); assert(accepted.ok, JSON.stringify(accepted))
  await observing
  assert.deepEqual(events.filter(event => event.kind === 'result').map(event => [event.outcome, event.code]), [['succeeded', 'output-limit']])
  assert.equal(driver.checkpoint().ok, false)
  assert.equal(c.native.writes.filter(frame => frame.method === 'turn/start').length, 1)
})

test('wrong native identities and unknown terminal status never become a successful canonical result', async t => {
  const a = await opened(t); await a.driver.submit(input()); const native = ref(a.native)
  await a.native.command({ kind: 'notify', method: 'turn/completed', params: { ...native, thread: { id: 'foreign' }, turn: { id: native.turnId, status: 'completed' } } })
  await a.native.command({ kind: 'finish', ...native, status: 'future-unknown-status' })
  await until(() => a.events.some(event => event.kind === 'result'))
  assert.deepEqual(a.events.filter(event => event.kind === 'result').map(event => event.outcome), ['unknown'])
  assert.deepEqual(await a.driver.submit(input(2)), { ok: false, code: 'unavailable', delivery: 'known-not-sent' })
})

test('an active close during preflight is known not sent and aborts caller probe without a turn write', async t => {
  const c = await context(t)
  let probing = false; let signal: AbortSignal | undefined
  const { driver } = await createCodexDriverFactory({ ...c.host, resolveConfiguration: async () => ({ ...c.config, probe: async current => {
    if (!probing) {return true}
    signal = current
    return new Promise<boolean>(resolve => { current.addEventListener('abort', () => resolve(false), { once: true }) })
  } }) }).open(c.request)
  t.after(() => driver.close()); probing = true
  const pending = driver.submit(input()); await until(() => signal !== undefined)
  const closing = driver.close()
  assert.equal(signal?.aborted, true)
  assert.deepEqual(await pending, { ok: false, code: 'unknown', delivery: 'known-not-sent' })
  await closing
  assert.equal(c.native.writes.some(frame => frame.method === 'turn/start'), false)
})

test('turn timeout keeps uncertainty, seals the protocol and rejects the queued turn without replay', async t => {
  const c = await context(t)
  const { driver } = await createCodexDriverFactory({ ...c.host, resolveConfiguration: async () => ({ ...c.config,
    limits: { ...c.config.limits, timeoutMs: 100 } }) }).open(c.request)
  t.after(() => driver.close())
  const events: Awaited<ReturnType<typeof opened>>['events'] = []
  const observing = (async () => { for await (const event of driver.observe()) {events.push(event)} })()
  await driver.submit(input()); const queued = driver.submit(input(2))
  assert.deepEqual(await queued, { ok: false, code: 'unknown', delivery: 'known-not-sent' }); await observing
  assert.deepEqual(events.filter(event => event.kind === 'result').map(event => event.outcome), ['unknown'])
  assert.equal(c.native.writes.filter(frame => frame.method === 'turn/start').length, 1)
})

test('legacy approvals use only proven current items and richer permissions never grant a guessed capability', async t => {
  const a = await opened(t); await a.driver.submit(input()); const native = ref(a.native)
  await a.native.command({ kind: 'notify', method: 'item/started', params: { ...native, item: { id: 'legacy', type: 'commandExecution', command: 'test' } } })
  await a.native.command({ kind: 'approval', requestId: 'legacy', method: 'execCommandApproval', params: { conversationId: native.threadId, callId: 'legacy' } })
  await until(() => a.events.some(event => event.kind === 'interaction'))
  const permission = a.events.find(event => event.kind === 'interaction'); assert(permission?.kind === 'interaction')
  for (const invalid of [null, undefined, [], Object.create({ kind: 'permission', decision: 'allow' }),
    { kind: 'permission', decision: true }, { kind: 'permission', get decision() { throw new Error('must not invoke accessor') } }])
    {assert.deepEqual(await a.driver.respondToInteraction(permission.interactionRef, invalid as never), { ok: false, code: 'unsupported' })}
  assert.deepEqual(await a.driver.respondToInteraction(permission.interactionRef, { kind: 'permission', decision: 'deny' }), { ok: true, value: undefined })
  await a.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 'legacy')
  assert.deepEqual(a.native.writes.find(frame => frame.id === 'legacy')?.result, { decision: 'denied' })
  await a.native.command({ kind: 'approval', requestId: 'rich', method: 'item/permissions/requestApproval', params: { ...native, itemId: 'rich', permissions: { network: { enabled: true } } } })
  await a.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 'rich')
  assert.deepEqual(a.native.writes.find(frame => frame.id === 'rich')?.result, { permissions: {}, scope: 'turn' })
  assert.equal(a.events.filter(event => event.kind === 'interaction').length, 1)
  assert(capabilities.includes('permission')); assert(!capabilities.includes('question'))
  await a.native.command({ kind: 'finish', ...native })
})

test('interrupt revokes an unanswered permission before native ACK and a late allow cannot grant', async t => {
  const a = await opened(t); await a.driver.submit(input()); const native = ref(a.native)
  await a.native.command({ kind: 'approval', requestId: 'revoked', method: 'item/commandExecution/requestApproval', params: { ...native, itemId: 'command' } })
  await until(() => a.events.some(event => event.kind === 'interaction'))
  const permission = a.events.find(event => event.kind === 'interaction'); assert(permission?.kind === 'interaction')
  const queued = a.driver.submit(input(2))
  await a.native.command({ kind: 'hold-interrupts' })
  const interrupt = a.driver.interrupt('op-1')
  assert.deepEqual(await a.driver.respondToInteraction(permission.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' })
  await a.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.method === 'turn/interrupt')
  await a.native.command({ kind: 'release-interrupts' }); assert((await interrupt).ok)
  assert.equal(a.native.writes.some(frame => frame.id === 'revoked'), false)
  assert.equal(a.events.some(event => event.kind === 'result'), false)
  assert.equal(a.native.writes.filter(frame => frame.method === 'turn/start').length, 1, 'interrupt ACK cannot advance queued B')
  await a.native.command({ kind: 'finish', ...native, status: 'interrupted' })
  assert((await queued).ok)
  await a.native.command({ kind: 'finish', ...ref(a.native, 'turn-2') })
  await until(() => a.events.some(event => event.kind === 'result'))
})
