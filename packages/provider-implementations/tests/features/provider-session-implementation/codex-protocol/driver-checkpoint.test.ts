import assert from 'node:assert/strict'
import { test } from 'node:test'
import { context, opened, input, ref, until } from './driver-support.ts'

test('selected restore carries item ownership: delayed first pre-checkpoint legacy A cannot grant reused B', async t => {
  const original = await opened(t); await original.driver.submit(input()); const a = ref(original.native)
  const item = { id: 'checkpoint-reused', type: 'commandExecution', command: 'TEST' }
  await original.native.command({ kind: 'notify', method: 'item/started', params: { ...a, item } })
  await original.native.command({ kind: 'finish', ...a }); await until(() => original.events.some(event => event.kind === 'result'))
  const checkpoint = original.driver.checkpoint(); assert(checkpoint.ok)
  const value = checkpoint.value as { version: number; itemOwners: unknown[] }
  assert.equal(value.version, 2); assert.equal(value.itemOwners.length, 1)
  await original.driver.close()
  const c = await context(t); c.checkpoint(checkpoint.value)
  const { driver } = await c.factory.open({ ...c.request, checkpointRef: 'exact-selected' }); t.after(() => driver.close())
  const events: typeof original.events = []
  const observing = (async () => { for await (const event of driver.observe()) {events.push(event)} })()
  t.after(async () => { await driver.close(); await observing })
  await driver.submit(input(2)); const b = ref(c.native)
  // The fresh synthetic process deliberately reuses the native turn ID too.
  assert.equal(b.turnId, a.turnId)
  await c.native.command({ kind: 'notify', method: 'item/started', params: { ...b, item } })
  await c.native.command({ kind: 'approval', requestId: 'delayed-FIRST-before-checkpoint', method: 'execCommandApproval',
    params: { conversationId: a.threadId, callId: item.id } })
  await c.native.waitFor(message => message.event === 'wire' && (message.message as Record<string, unknown>)?.id === 'delayed-FIRST-before-checkpoint')
  assert.equal(c.native.writes.find(frame => frame.id === 'delayed-FIRST-before-checkpoint')?.result, undefined)
  assert.equal(events.some(event => event.kind === 'interaction'), false)
  await c.native.command({ kind: 'approval', requestId: 'modern-restored-B', method: 'item/commandExecution/requestApproval', params: { ...b, itemId: item.id } })
  await until(() => events.some(event => event.kind === 'interaction'))
  const permission = events.find(event => event.kind === 'interaction'); assert(permission?.kind === 'interaction'); assert.equal(permission.operationRef, 'op-2')
  assert((await driver.respondToInteraction(permission.interactionRef, { kind: 'permission', decision: 'allow' })).ok)
  await c.native.waitFor(message => message.event === 'wire' && (message.message as Record<string, unknown>)?.id === 'modern-restored-B')
  assert.deepEqual(c.native.writes.find(frame => frame.id === 'modern-restored-B')?.result, { decision: 'accept' })
  await c.native.command({ kind: 'finish', ...b })
})

test('malformed, old or oversized checkpoint history fails before IO and cannot create a fresh thread', async t => {
  const original = await opened(t)
  const checkpoint = original.driver.checkpoint(); assert(checkpoint.ok)
  const value = checkpoint.value as Record<string, unknown>
  const validOwner = 'b6476e50-592a-4ef5-98ea-7673671e986c'
  const malformed = [null, { ...value, version: 1 }, { ...value, itemOwners: undefined }, { ...value, legacyItemsExhausted: 'false' },
    { ...value, itemOwners: [['item', validOwner], ['item', validOwner]] }, { ...value, itemOwners: [['item', 'unbound-owner']] },
    { ...value, itemOwners: [['item', validOwner, 'extra']] }, { ...value, itemOwners: [['λ'.repeat(4097), validOwner]] },
    { ...value, itemOwners: Array.from({ length: 51 }, (_, index) => [`item-${index}`, validOwner]) },
    { ...value, itemOwners: [Object.defineProperty(['item', validOwner], '0', { get() { throw new Error('must not read accessor') } })] },
    { ...value, extra: true }, Object.defineProperty({ ...value }, 'itemOwners', { get() { throw new Error('must not read accessor') } })]
  for (const candidate of malformed) {
    const c = await context(t); c.checkpoint(candidate)
    await assert.rejects(c.factory.open({ ...c.request, checkpointRef: 'malformed' }), /checkpoint-incompatible/)
    assert.equal(c.native.writes.length, 0)
  }
})

test('checkpoint count and pair bounds reject before traversing attacker-controlled array keys', async t => {
  const original = await opened(t)
  const checkpoint = original.driver.checkpoint(); assert(checkpoint.ok)
  const value = checkpoint.value as Record<string, unknown>
  let traversals = 0
  const watched = (entries: unknown[]) => new Proxy(entries, {
    ownKeys(target) { traversals++; return Reflect.ownKeys(target) },
  })
  for (const itemOwners of [watched(Array.from({ length: 51 }, () => [])), [watched(['item', 'owner', 'extra'])]]) {
    const c = await context(t); c.checkpoint({ ...value, itemOwners })
    await assert.rejects(c.factory.open({ ...c.request, checkpointRef: 'oversized-array' }), /checkpoint-incompatible/)
    assert.equal(c.native.writes.length, 0)
    assert.equal(traversals, 0, 'array length must be bounded before descriptors or element copying')
  }
})
