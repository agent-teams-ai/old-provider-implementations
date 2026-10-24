import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import type { Event } from '@agent-teams/provider-session-contracts'
import { createCodexDriverFactory } from '../../../../src/codex.ts'
import type { CodexInputWindowPort, CodexInputWindowRequest } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/input-window-capture.ts'
import { context, input, ref, until } from './driver-support.ts'
import { gate } from './subprocess-fixture.ts'

async function captured(t: TestContext, port: CodexInputWindowPort) {
  const a = await context(t)
  const factory = createCodexDriverFactory({ ...a.host, resolveConfiguration: async () => ({ ...a.config, capture: port }) })
  const { driver } = await factory.open(a.request)
  const events: Event[] = []
  const observing = (async () => { for await (const event of driver.observe()) { events.push(event) } })()
  t.after(async () => { await driver.close(); await observing })
  return { ...a, driver, events }
}

test('awaits original before and matching final observer before terminal or next input; snapshots callback and native file items', async t => {
  const before = gate(); const after = gate(); const requests: CodexInputWindowRequest[] = []
  const port: CodexInputWindowPort = { observe: async request => {
    requests.push(request)
    if (request.phase === 'before' && request.inputId === 'input-1') { await before.promise }
    if (request.phase === 'after' && request.inputId === 'input-1') { await after.promise }
  } }
  const a = await captured(t, port)
  port.observe = () => { throw new Error('changed callback must not be used') }
  const mutable = input(); const accepted = a.driver.submit(mutable); mutable.content = 'changed'; mutable.operationRef = 'changed'
  await until(() => requests.length === 1)
  assert.equal(a.native.writes.some(frame => frame.method === 'turn/start'), false)
  before.release(); assert((await accepted).ok)
  assert.deepEqual((a.native.writes.find(frame => frame.method === 'turn/start')!.params as Record<string, unknown>).input,
    [{ type: 'text', text: 'message 1', text_elements: [] }])
  const native = ref(a.native)
  const changes = [{ path: '/TEST-disposable/dirty.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-dirty\n+final\n' }]
  await a.native.command({ kind: 'notify', method: 'item/completed', params: { ...native, turnId: 'wrong-turn', item: { type: 'fileChange', id: 'wrong-item', changes, status: 'completed' } } })
  for (const method of ['item/started', 'item/completed']) {
    await a.native.command({ kind: 'notify', method, params: { ...native, item: { type: 'fileChange', id: 'edit-1', changes, status: 'completed' } } })
  }
  const queued = a.driver.submit(input(2))
  await a.native.command({ kind: 'finish', ...native })
  await until(() => requests.some(request => request.phase === 'after'))
  assert.equal(a.events.some(event => event.kind === 'result'), false)
  assert.equal(a.native.writes.filter(frame => frame.method === 'turn/start').length, 1)
  const final = requests.find(request => request.phase === 'after'); assert(final?.phase === 'after')
  assert.equal(final.beforeObserved, true); assert.equal(final.gapReason, undefined)
  assert.equal(final.operationRef, 'op-1'); assert.equal(final.inputId, 'input-1')
  assert.equal(final.threadId, native.threadId); assert.equal(final.turnId, native.turnId)
  assert.deepEqual(final.items.map(item => [item.itemId, item.phase]), [['edit-1', 'started'], ['edit-1', 'completed']])
  assert.deepEqual(final.items[1]!.changes, changes)
  assert(Object.isFrozen(final)); assert(Object.isFrozen(final.items[1]!.changes))
  after.release(); assert((await queued).ok)
  await a.native.command({ kind: 'finish', ...ref(a.native, 'turn-2'), status: 'failed' })
  await until(() => a.events.filter(event => event.kind === 'result').length === 2)
  const next = requests.find(request => request.phase === 'after' && request.inputId === 'input-2'); assert(next?.phase === 'after')
  assert.equal(next.outcome, 'failed'); assert.deepEqual(next.items, [])
  assert.notEqual(next.windowRef, final.windowRef)
})

test('timeout aborts missed before window; late completion cannot resurrect baseline and work continues', async t => {
  const delayed = gate(); const requests: CodexInputWindowRequest[] = []
  const a = await captured(t, { observe: async request => {
    requests.push(request)
    if (request.phase === 'before') { await delayed.promise }
  } })
  const accepted = a.driver.submit(input())
  await until(() => requests.some(request => request.phase === 'before'))
  const before = requests[0]!; assert.equal(before.signal.aborted, false)
  assert((await accepted).ok)
  assert.equal(before.signal.aborted, true)
  assert(requests.some(request => request.phase === 'gap' && request.reason === 'timeout'))
  delayed.release()
  await a.native.command({ kind: 'finish', ...ref(a.native) })
  await until(() => a.events.some(event => event.kind === 'result'))
  const final = requests.find(request => request.phase === 'after'); assert(final?.phase === 'after')
  assert.equal(final.beforeObserved, false); assert.equal(final.gapReason, 'timeout')
  assert.equal(final.windowRef, before.windowRef)
  assert(a.events.some(event => event.kind === 'result' && event.outcome === 'succeeded'))
})

test('close while before is pending never starts turn even after late observer completion', async t => {
  const delayed = gate(); const requests: CodexInputWindowRequest[] = []
  const a = await captured(t, { observe: async request => {
    requests.push(request)
    if (request.phase === 'before') { await delayed.promise }
  } })
  const accepted = a.driver.submit(input())
  await until(() => requests.length > 0)
  await a.driver.close()
  assert.deepEqual(await accepted, { ok: false, code: 'unknown', delivery: 'known-not-sent' })
  delayed.release()
  await until(() => requests.some(request => request.phase === 'gap'))
  assert.equal(requests[0]!.signal.aborted, true)
  assert.equal(a.native.writes.some(frame => frame.method === 'turn/start'), false)
  assert.equal(requests.some(request => request.phase === 'after'), false)
})

test('observer failures are explicit gaps rather than native denial; an unresolved gap callback does not block work or terminal', async t => {
  const requests: CodexInputWindowRequest[] = []; const gap = gate()
  const a = await captured(t, { observe: async request => {
    requests.push(request)
    if (request.phase === 'before' && request.inputId === 'input-1') { throw new Error('TEST observer failure') }
    if (request.phase === 'gap' && request.reason === 'transport') { await gap.promise }
  } })
  assert((await a.driver.submit(input())).ok)
  assert(requests.some(request => request.phase === 'gap' && request.reason === 'capture-failed'))
  await a.native.command({ kind: 'finish', ...ref(a.native) })
  await until(() => a.events.some(event => event.kind === 'result'))
  const final = requests.find(request => request.phase === 'after'); assert(final?.phase === 'after')
  assert.equal(final.beforeObserved, false); assert.equal(final.gapReason, 'capture-failed')
  assert((await a.driver.submit(input(2))).ok)
  await a.native.command({ kind: 'disconnect' })
  await until(() => a.events.filter(event => event.kind === 'result').length === 2)
  assert.equal(a.events.filter(event => event.kind === 'result').at(-1)?.outcome, 'unknown')
  assert(requests.some(request => request.phase === 'gap' && request.reason === 'transport'))
  gap.release()
})

test('after failure and rejecting gap remain best effort; interrupted outcome is observed before following input', async t => {
  const requests: CodexInputWindowRequest[] = []
  const a = await captured(t, { observe: async request => {
    requests.push(request)
    if (request.phase === 'after' && request.inputId === 'input-1') { throw new Error('TEST after failure') }
    if (request.phase === 'gap') { await Promise.reject(new Error('TEST gap failure')) }
  } })
  assert((await a.driver.submit(input())).ok)
  const queued = a.driver.submit(input(2))
  await a.native.command({ kind: 'finish', ...ref(a.native), status: 'interrupted' })
  assert((await queued).ok)
  await a.native.command({ kind: 'finish', ...ref(a.native, 'turn-2') })
  await until(() => a.events.filter(event => event.kind === 'result').length === 2)
  assert.deepEqual(a.events.filter(event => event.kind === 'result').map(event => event.outcome), ['cancelled', 'succeeded'])
  assert(requests.some(request => request.phase === 'after' && request.inputId === 'input-1' && request.outcome === 'interrupted'))
  assert(requests.some(request => request.phase === 'gap' && request.reason === 'capture-failed'))
})

test('bounded file item inventory fails closed without denying ordinary completion or accepting a foreign terminal', async () => {
  const { CodexInputWindowCapture } = await import('../../../../src/features/provider-session-implementation/adapters/codex-protocol/input-window-capture.ts')
  const requests: CodexInputWindowRequest[] = []
  const make = () => new CodexInputWindowCapture({ identity: { sessionRef: 'TEST', windowRef: 'window', inputId: 'input', operationRef: 'op', threadId: 'thread' },
    port: { observe: request => { requests.push(request) } }, abort: new AbortController().signal, timeoutMs: 100, maxBytes: 64, maxItems: 1 })
  const capture = make(); await capture.before()
  const event = { threadId: 'thread', turnId: 'turn', event: { type: 'tool_call_started' as const, toolSource: 'native' as const, itemId: 'edit', toolName: 'fileChange', arguments: { changes: [] }, status: 'started', rawItemType: 'fileChange' } }
  capture.record(event); capture.record(event)
  await capture.after({ threadId: 'thread', turnId: 'turn', outcome: 'completed' })
  const final = requests.find(request => request.phase === 'after'); assert(final?.phase === 'after')
  assert.equal(final.beforeObserved, true); assert.equal(final.gapReason, 'limit'); assert.equal(final.items.length, 1)
  requests.length = 0
  const foreign = make(); await foreign.before(); foreign.record(event)
  await foreign.after({ threadId: 'thread', turnId: 'other-turn', outcome: 'completed' })
  await until(() => requests.some(request => request.phase === 'gap'))
  assert.equal(requests.some(request => request.phase === 'after'), false)
  assert(requests.some(request => request.phase === 'gap' && request.reason === 'conflict'))
})


test('capture snapshots a structural observer method exactly once', async () => {
  const { snapshotInputWindowPort } = await import('../../../../src/features/provider-session-implementation/adapters/codex-protocol/input-window-capture.ts')
  let reads = 0; let calls = 0
  const receiver = { get observe() { reads++; return function (this: unknown) { assert.equal(this, receiver); calls++ } } }
  const port = snapshotInputWindowPort(receiver)!
  assert.equal(reads, 1)
  await port.observe({ phase: 'before', sessionRef: 'TEST', windowRef: 'window', inputId: 'input', operationRef: 'op', threadId: 'thread', signal: new AbortController().signal })
  assert.equal(reads, 1); assert.equal(calls, 1)
})


test('configuration never rereads an initially absent capture getter through object spread', async t => {
  const { captureDriverConfig } = await import('../../../../src/features/provider-session-implementation/adapters/codex-protocol/driver-config.ts')
  const a = await context(t)
  let reads = 0
  Object.defineProperty(a.config, 'capture', { enumerable: true, get() {
    reads++
    return reads === 1 ? undefined : { observe() { throw new Error('unsnapshotted observer') } }
  } })
  const selected = captureDriverConfig(a.config, a.request)
  assert.equal(reads, 1)
  assert.equal(Object.hasOwn(selected, 'capture'), false)
})
