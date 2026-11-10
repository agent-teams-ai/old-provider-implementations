import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { CodexAppServerClient, CodexProtocolError } from '../../../../src/codex.ts'
import type { CodexApprovalReply, CodexAppServerEvent } from '../../../../src/codex.ts'
import { CodexRpcClient } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/rpc-client.ts'
import { fixture, gate } from './subprocess-fixture.ts'

const input = (text: string) => ({ input: [{ type: 'text', text, text_elements: [] }] })
const initialize = { clientInfo: { name: 'isolated-test', version: '0.0.0' }, capabilities: { experimentalApi: false } }
const declined = async (): Promise<CodexApprovalReply> => ({ kind: 'decision', decision: 'decline' })
const hasCode = (code: string, acceptance?: string) => (error: unknown) => error instanceof CodexProtocolError && error.code === code && (!acceptance || error.acceptance === acceptance)

// Each test spawns only a synthetic JSON-RPC process in its own new temporary directory.
test('native subprocess supports ordered turns, immutable queued input and distinct terminal/usage observations', async t => {
  const native = await fixture(t)
  const events: CodexAppServerEvent[] = []
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: event => events.push(event), requestApproval: declined })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({ cwd: '/sandbox', approvalPolicy: 'on-request', sandbox: 'read-only' })
  const first = session.submitTurn(input('first'))
  const queuedInput = input('original second')
  const second = session.submitTurn(queuedInput)
  queuedInput.input[0]!.text = 'mutated by caller'
  const a = await first.accepted
  assert.equal(native.writes.filter(frame => frame.method === 'turn/start').length, 1)
  await native.command({ kind: 'notify', method: 'item/agentMessage/delta', params: { ...a, itemId: 'answer', delta: 'P' } })
  await native.command({ kind: 'notify', method: 'item/agentMessage/delta', params: { ...a, itemId: 'answer', delta: 'ONG ' } })
  await native.command({ kind: 'notify', method: 'thread/tokenUsage/updated', params: { ...a, tokenUsage: { last: { inputTokens: 0 } } } })
  await native.command({ kind: 'notify', method: 'item/completed', params: { ...a, item: { id: 'answer', type: 'agentMessage', text: 'PONG!' } } })
  await native.command({ kind: 'finish', ...a })
  assert.deepEqual(await first.completed, { ...a, outcome: 'completed' })
  const b = await second.accepted
  const started = native.writes.filter(frame => frame.method === 'turn/start')
  assert.deepEqual((started[1]!.params as Record<string, unknown>).input, input('original second').input)
  await native.command({ kind: 'finish', ...b, status: 'failed' })
  assert.deepEqual(await second.completed, { ...b, outcome: 'failed' })
  assert.deepEqual(events.filter(entry => entry.turnId === a.turnId && ['assistant_text', 'usage_updated', 'turn_completed'].includes(entry.event.type)).map(entry => entry.event), [
    { type: 'assistant_text', itemId: 'answer', text: 'PONG!' },
    { type: 'usage_updated', inputTokens: 0 }, { type: 'turn_completed', turnId: a.turnId },
  ])
  assert.deepEqual(events.find(entry => entry.turnId === b.turnId && entry.event.type === 'turn_failed')?.event, { type: 'turn_failed', turnId: b.turnId })
})

test('early deltas and completion wait for the actual turn/start identity receipt', async t => {
  const native = await fixture(t)
  const events: CodexAppServerEvent[] = []
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: event => events.push(event), requestApproval: declined })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const turn = session.submitTurn({ ...input('early'), fixtureEarly: true })
  const ref = await turn.accepted
  assert.deepEqual(await turn.completed, { ...ref, outcome: 'completed' })
  assert.deepEqual(events.filter(entry => entry.event.type === 'assistant_text'), [{ ...ref, event: { type: 'assistant_text', itemId: 'early', text: 'early text' } }])
})

test('terminal cancels pending approval; a late allow reply cannot escape into the next turn', async t => {
  const native = await fixture(t)
  const called = gate()
  let decide!: (reply: CodexApprovalReply) => void
  let approvalSignal: AbortSignal | undefined
  let calls = 0
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: async (_request, signal) => {
    calls++
    approvalSignal = signal
    called.release()
    return new Promise(resolve => { decide = resolve })
  } })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const first = session.submitTurn(input('A'))
  const second = session.submitTurn(input('B'))
  const a = await first.accepted
  await native.command({ kind: 'approval', requestId: 'approval-A', method: 'item/commandExecution/requestApproval', params: { ...a, itemId: 'tool-A', command: 'test' } })
  await called.promise
  await native.command({ kind: 'finish', ...a })
  await first.completed
  const b = await second.accepted
  assert.equal(approvalSignal?.aborted, true)
  decide({ kind: 'decision', decision: 'acceptForSession' })
  // A subsequent real wire request is a barrier after the late callback's microtasks.
  await client.startThread({})
  assert.equal(native.writes.some(frame => frame.id === 'approval-A'), false)
  await native.command({ kind: 'approval', requestId: 'wrong-turn', method: 'item/commandExecution/requestApproval', params: { threadId: b.threadId, turnId: a.turnId, itemId: 'tool-A' } })
  await native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 'wrong-turn')
  assert.equal(calls, 1)
  assert.deepEqual(native.writes.find(frame => frame.id === 'wrong-turn')?.error, { code: -32001, message: 'codex.protocol.unattributed-approval' })
  await native.command({ kind: 'finish', ...b })
  await second.completed
})

test('an interrupt captured for A cannot cancel B when its dispatch/reply is delayed', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: declined })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const first = session.submitTurn(input('A'))
  const second = session.submitTurn(input('B'))
  const a = await first.accepted
  const blocked = native.blockNextWrite()
  const interrupt = session.interrupt(a).catch(error => error as unknown)
  await blocked.started
  await native.command({ kind: 'finish', ...a })
  await first.completed
  blocked.release()
  const b = await second.accepted
  assert.ok(hasCode('codex.protocol.request-aborted', 'unknown')(await interrupt))
  assert.deepEqual(native.writes.find(frame => frame.method === 'turn/interrupt')?.params, a)
  await assert.rejects(session.interrupt(a), hasCode('codex.protocol.stale-turn', 'not-sent'))
  await native.command({ kind: 'finish', ...a, status: 'interrupted' }) // Duplicate old terminal is merely an old scoped observation.
  await native.command({ kind: 'finish', ...b })
  assert.deepEqual(await second.completed, { ...b, outcome: 'completed' })
})

test('explicit native resume plus active cancellation targets only the accepted turn', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: declined })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.resumeThread('persisted-native-thread', { model: 'consumer-selected' })
  assert.equal(session.threadId, 'persisted-native-thread')
  assert.deepEqual(native.writes.find(frame => frame.method === 'thread/resume')?.params, { model: 'consumer-selected', threadId: 'persisted-native-thread' })
  const abort = new AbortController()
  const turn = session.submitTurn(input('stop'), abort.signal)
  const ref = await turn.accepted
  abort.abort()
  assert.deepEqual(await turn.completed, { ...ref, outcome: 'interrupted' })
  assert.deepEqual(native.writes.find(frame => frame.method === 'turn/interrupt')?.params, ref)
})

test('transport loss retains partial text, seals the session and never replays queued input', async t => {
  const native = await fixture(t)
  const events: CodexAppServerEvent[] = []
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: event => events.push(event), requestApproval: declined })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const first = session.submitTurn(input('may have effects'))
  const queued = session.submitTurn(input('must not replay'))
  const ref = await first.accepted
  await native.command({ kind: 'notify', method: 'item/agentMessage/delta', params: { ...ref, itemId: 'partial', delta: 'partial output' } })
  await native.command({ kind: 'disconnect' })
  await assert.rejects(first.completed, hasCode('codex.protocol.transport-lost', 'unknown'))
  await assert.rejects(queued.accepted, hasCode('codex.protocol.transport-lost', 'not-sent'))
  await assert.rejects(queued.completed, hasCode('codex.protocol.transport-lost', 'not-sent'))
  assert.deepEqual(events.filter(entry => entry.event.type === 'assistant_text'), [{ ...ref, event: { type: 'assistant_text', itemId: 'partial', text: 'partial output' } }])
  assert.equal(native.writes.filter(frame => frame.method === 'turn/start').length, 1)
  assert.throws(() => session.submitTurn(input('again')), hasCode('codex.protocol.session-closed', 'not-sent'))
})

test('close seals synchronously, rejects pending requests and never invokes an already-queued write', async t => {
  const native = await fixture(t)
  const rpc = new CodexRpcClient(native.transport, { notification: () => {}, request: async () => null, closed: () => {} })
  t.after(() => rpc.close())
  const blocked = native.blockNextWrite()
  const first = rpc.request('fixture/hold', {})
  void first.catch(() => {})
  await blocked.started
  const queued = rpc.request('thread/start', {})
  void queued.catch(() => {})
  rpc.close()
  await assert.rejects(first, hasCode('codex.protocol.closed', 'unknown'))
  await assert.rejects(queued, hasCode('codex.protocol.closed', 'not-sent'))
  blocked.release()
  await setImmediate()
  assert.deepEqual(native.writes.map(frame => frame.method), ['fixture/hold'])
})

test('request timeout keeps acceptance unknown; a late reply cannot satisfy a subsequent request', async t => {
  const native = await fixture(t)
  const rpc = new CodexRpcClient(native.transport, { notification: () => {}, request: async () => null, closed: () => {} }, { requestTimeoutMs: 40, maxPendingRequests: 1 })
  t.after(() => rpc.close())
  const held = rpc.request('fixture/hold', {})
  await assert.rejects(rpc.request('thread/start', {}), hasCode('codex.protocol.pending-limit', 'not-sent'))
  await assert.rejects(held, hasCode('codex.protocol.request-timeout', 'unknown'))
  const id = native.writes[0]!.id
  await native.command({ kind: 'raw', text: `${JSON.stringify({ jsonrpc: '2.0', id, result: { corrupt: 'late' } })}\n` })
  const next = await rpc.request('thread/start', {})
  assert.deepEqual(next, { thread: { id: 'thread-1' } })
  assert.equal(native.writes.filter(frame => frame.method === 'fixture/hold').length, 1)
})

test('unknown attribution and native terminal status never become a successful turn', async t => {
  const native = await fixture(t)
  const events: CodexAppServerEvent[] = []
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: event => events.push(event), requestApproval: declined })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const turn = session.submitTurn(input('observe'))
  const ref = await turn.accepted
  await native.command({ kind: 'notify', method: 'turn/completed', params: { turn: { id: ref.turnId, status: 'completed' } } })
  await native.command({ kind: 'finish', ...ref, status: 'future-status' })
  assert.deepEqual(await turn.completed, { ...ref, outcome: 'unknown' })
  assert.ok(events.some(entry => entry.threadId === undefined && entry.event.type === 'unsupported_raw_event'))
  assert.ok(!events.some(entry => entry.event.type === 'turn_completed'))
  assert.throws(() => session.submitTurn(input('unsafe next')), hasCode('codex.protocol.session-closed', 'not-sent'))
})


test('native modern and legacy approval replies require independent current-turn attribution', async t => {
  const native = await fixture(t)
  let calls = 0
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: async request => { calls++; return { kind: 'decision', decision: request.method === 'execCommandApproval' ? 'denied' : 'decline' } } })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const submission = session.submitTurn(input('approval'))
  const ref = await submission.accepted
  const waitReply = (id: string) => native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === id)
  await native.command({ kind: 'approval', requestId: 'modern', method: 'item/commandExecution/requestApproval', params: { ...ref, itemId: 'modern-item' } })
  await waitReply('modern')
  assert.deepEqual(native.writes.find(frame => frame.id === 'modern')?.result, { decision: 'decline' })
  await native.command({ kind: 'approval', requestId: 'unknown-legacy', method: 'execCommandApproval', params: { conversationId: ref.threadId, callId: 'missing-item' } })
  await waitReply('unknown-legacy')
  assert.equal(calls, 1)
  await native.command({ kind: 'notify', method: 'item/started', params: { ...ref, item: { type: 'commandExecution', id: 'proven-legacy-item', command: 'test' } } })
  // Legacy protocol uses its own explicit wire decision vocabulary.
  await native.command({ kind: 'approval', requestId: 'proven-legacy', method: 'execCommandApproval', params: { conversationId: ref.threadId, callId: 'proven-legacy-item' } })
  await waitReply('proven-legacy')
  assert.equal(calls, 2)
  assert.deepEqual(native.writes.find(frame => frame.id === 'proven-legacy')?.result, { decision: 'denied' })
  await native.command({ kind: 'finish', ...ref })
  await submission.completed
})

test('client close aborts the approval callback and suppresses its eventual result', async t => {
  const native = await fixture(t)
  const called = gate()
  let completeReply!: (reply: CodexApprovalReply) => void
  let signal: AbortSignal | undefined
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: async (_request, abort) => {
    signal = abort
    called.release()
    return new Promise(resolve => { completeReply = resolve })
  } })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const submission = session.submitTurn(input('close'))
  const ref = await submission.accepted
  await native.command({ kind: 'approval', requestId: 'close-approval', method: 'item/commandExecution/requestApproval', params: { ...ref, itemId: 'item' } })
  await called.promise
  client.close()
  assert.equal(signal?.aborted, true)
  completeReply({ kind: 'decision', decision: 'accept' })
  await assert.rejects(submission.completed, hasCode('codex.protocol.closed', 'unknown'))
  await setImmediate()
  assert.equal(native.writes.some(frame => frame.id === 'close-approval'), false)
})

test('queued cancellation is known not sent and cannot consume a future turn', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: declined })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const first = session.submitTurn(input('A'))
  const a = await first.accepted
  const abort = new AbortController()
  const queued = session.submitTurn(input('cancel queued'), abort.signal)
  abort.abort()
  await assert.rejects(queued.accepted, hasCode('codex.protocol.cancelled-before-dispatch', 'not-sent'))
  await assert.rejects(queued.completed, hasCode('codex.protocol.cancelled-before-dispatch', 'not-sent'))
  await native.command({ kind: 'finish', ...a })
  await first.completed
  assert.equal(native.writes.filter(frame => frame.method === 'turn/start').length, 1)
})


test('a sink disposing the client on terminal projection cannot erase its known native outcome', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, requestApproval: declined, onEvent: entry => {
    if (entry.event.type === 'turn_completed') {client.close()}
  } })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const submission = session.submitTurn(input('terminal'))
  const ref = await submission.accepted
  await native.command({ kind: 'finish', ...ref })
  assert.deepEqual(await submission.completed, { ...ref, outcome: 'completed' })
})


test('conflicting direct/nested native identities cannot finish a turn or establish approval proof', async t => {
  const native = await fixture(t)
  let calls = 0
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: async () => {
    calls++
    return { kind: 'decision', decision: 'denied' }
  } })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const submission = session.submitTurn(input('identity'))
  const ref = await submission.accepted
  await native.command({ kind: 'notify', method: 'turn/completed', params: { ...ref, turn: { id: 'foreign-turn', status: 'completed' } } })
  await native.command({ kind: 'notify', method: 'turn/completed', params: { ...ref, thread: { id: 'foreign-thread' }, turn: { id: ref.turnId, status: 'completed' } } })
  await native.command({ kind: 'notify', method: 'item/started', params: { ...ref, itemId: 'forged-proof', item: { id: 'real-item', type: 'commandExecution', command: 'test' } } })
  await native.command({ kind: 'approval', requestId: 'conflicting-item', method: 'execCommandApproval', params: { conversationId: ref.threadId, callId: 'forged-proof' } })
  await native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 'conflicting-item')
  assert.equal(calls, 0)
  await native.command({ kind: 'finish', ...ref, status: 'failed' })
  assert.deepEqual(await submission.completed, { ...ref, outcome: 'failed' })
})


test('a callback rejecting after synchronously closing its client leaves no orphan rejection', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: async () => {
    client.close()
    throw new Error('callback stopped with client')
  } })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const submission = session.submitTurn(input('callback close'))
  const ref = await submission.accepted
  await native.command({ kind: 'approval', requestId: 'callback-close', method: 'item/commandExecution/requestApproval', params: { ...ref, itemId: 'item' } })
  await assert.rejects(submission.completed, hasCode('codex.protocol.closed', 'unknown'))
  await setImmediate()
  assert.equal(native.writes.some(frame => frame.id === 'callback-close'), false)
})

test('an approval abort listener closing its client cannot erase an already observed native terminal', async t => {
  const native = await fixture(t)
  const called = gate()
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: async (_request, signal) => {
    signal.addEventListener('abort', () => client.close(), { once: true })
    called.release()
    return new Promise<CodexApprovalReply>(() => {})
  } })
  t.after(() => client.close())
  await client.initialize(initialize)
  const session = await client.startThread({})
  const submission = session.submitTurn(input('terminal-before-revocation'))
  const ref = await submission.accepted
  await native.command({ kind: 'approval', requestId: 'abort-closes-client', method: 'item/commandExecution/requestApproval', params: { ...ref, itemId: 'item' } })
  await called.promise
  await native.command({ kind: 'finish', ...ref })
  assert.deepEqual(await submission.completed, { ...ref, outcome: 'completed' })
  assert.equal(native.writes.some(frame => frame.id === 'abort-closes-client'), false)
})
