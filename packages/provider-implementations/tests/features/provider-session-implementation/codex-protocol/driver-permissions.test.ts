import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCodexDriverFactory } from '../../../../src/codex.ts'
import { context, opened, input, ref, until } from './driver-support.ts'

test('delayed first legacy A approval after cross-turn item reuse cannot grant B; exact modern B remains usable', async t => {
  const a = await opened(t); await a.driver.submit(input()); const first = ref(a.native)
  const item = { id: 'reused-item', type: 'commandExecution', command: 'TEST' }
  await a.native.command({ kind: 'notify', method: 'item/started', params: { ...first, item } })
  await a.native.command({ kind: 'finish', ...first }); await until(() => a.events.some(event => event.kind === 'result'))
  await a.driver.submit(input(2)); const second = ref(a.native, 'turn-2')
  await a.native.command({ kind: 'notify', method: 'item/started', params: { ...second, item } })
  await a.native.command({ kind: 'approval', requestId: 'delayed-FIRST-legacy-A', method: 'execCommandApproval',
    params: { conversationId: first.threadId, callId: 'reused-item' } })
  await a.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 'delayed-FIRST-legacy-A')
  const refused = a.native.writes.find(frame => frame.id === 'delayed-FIRST-legacy-A')
  assert.equal(refused?.result, undefined); assert.deepEqual(refused?.error, { code: -32000, message: 'codex.protocol.request-rejected' })
  assert.equal(a.events.some(event => event.kind === 'interaction'), false)
  await a.native.command({ kind: 'approval', requestId: 'modern-B', method: 'item/commandExecution/requestApproval', params: { ...second, itemId: 'reused-item' } })
  await until(() => a.events.some(event => event.kind === 'interaction'))
  const permission = a.events.find(event => event.kind === 'interaction'); assert(permission?.kind === 'interaction'); assert.equal(permission.operationRef, 'op-2')
  assert.deepEqual(await a.driver.respondToInteraction(permission.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined })
  await a.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 'modern-B')
  assert.deepEqual(a.native.writes.find(frame => frame.id === 'modern-B')?.result, { decision: 'accept' })
  await a.native.command({ kind: 'finish', ...second })
})

test('physical-thread item history never evicts: exhausted legacy budget fails closed while exact modern approval still works', async t => {
  const c = await context(t)
  const { driver } = await createCodexDriverFactory({ ...c.host, resolveConfiguration: async () => ({ ...c.config, limits: { ...c.config.limits, outputEvents: 4 } }) }).open(c.request)
  t.after(() => driver.close())
  const events: Awaited<ReturnType<typeof opened>>['events'] = []
  const observing = (async () => { for await (const event of driver.observe()) {events.push(event)} })()
  t.after(async () => { await driver.close(); await observing })
  for (let n = 1; n <= 5; n++) {
    await driver.submit(input(n)); const current = ref(c.native, `turn-${n}`)
    await c.native.command({ kind: 'notify', method: 'item/started', params: { ...current, item: { id: `item-${n}`, type: 'commandExecution', command: 'TEST' } } })
    if (n < 5) { await c.native.command({ kind: 'finish', ...current }); await until(() => events.filter(event => event.kind === 'result').length === n) }
  }
  const current = ref(c.native, 'turn-5')
  await c.native.command({ kind: 'approval', requestId: 'legacy-exhausted', method: 'execCommandApproval', params: { conversationId: current.threadId, callId: 'item-5' } })
  await c.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 'legacy-exhausted')
  assert.equal(c.native.writes.find(frame => frame.id === 'legacy-exhausted')?.result, undefined)
  assert(events.some(event => event.kind === 'diagnostic' && event.code === 'output-limit' && event.operationRef === 'op-5'))
  await c.native.command({ kind: 'approval', requestId: 'modern-exact', method: 'item/commandExecution/requestApproval', params: { ...current, itemId: 'item-5' } })
  await until(() => events.some(event => event.kind === 'interaction'))
  const permission = events.find(event => event.kind === 'interaction'); assert(permission?.kind === 'interaction')
  assert((await driver.respondToInteraction(permission.interactionRef, { kind: 'permission', decision: 'allow' })).ok)
  await c.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 'modern-exact')
  assert.deepEqual(c.native.writes.find(frame => frame.id === 'modern-exact')?.result, { decision: 'accept' })
  await c.native.command({ kind: 'finish', ...current })
})

test('close is already memoized when a caller probe abort callback reenters close', async t => {
  const c = await context(t)
  let stopping = 0; let reentrant: Promise<unknown> | undefined; let waiting = false
  let driver: Awaited<ReturnType<typeof opened>>['driver']
  const result = await createCodexDriverFactory({ ...c.host, resolveConfiguration: async () => ({ ...c.config,
    confirmStopped: async () => { stopping++; return true }, probe: async signal => {
      if (!waiting) {return true}
      return new Promise<boolean>(resolve => { signal.addEventListener('abort', () => { reentrant = driver.close(); resolve(false) }, { once: true }) })
    } }) }).open(c.request)
  driver = result.driver; t.after(() => driver.close()); waiting = true
  const pending = driver.submit(input()); const closing = driver.close()
  assert.equal(reentrant, closing); await closing; await pending; assert.equal(stopping, 1)
})
