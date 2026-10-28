import assert from 'node:assert/strict'
import { test } from 'node:test'
import { opened, input, ref, until } from './driver-support.ts'

test('two actual native sessions map serial text/tools/usage without mixing runtime identities', async t => {
  const a = await opened(t); const b = await opened(t, 'runtime-B')
  const accepted = await a.driver.submit(input()); assert(accepted.ok)
  assert.deepEqual(accepted.value, { inputId: 'input-1', operationRef: 'op-1', delivery: 'client-consumed', providerAcceptance: 'unknown' })
  await b.driver.submit(input())
  const mutable = input(2); const queued = a.driver.submit(mutable); mutable.content = 'mutated'
  assert.deepEqual(await a.driver.submit(input(3)), { ok: false, code: 'backpressure', delivery: 'known-not-sent' })
  assert.equal(a.native.writes.filter(frame => frame.method === 'turn/start').length, 1)
  const native = ref(a.native)
  for (const [method, item] of [
    ['item/completed', { id: 'message-1', type: 'agentMessage', text: 'hello' }],
    ['item/started', { id: 'tool-1', type: 'mcpToolCall', server: 'control', tool: 'team_send_message', arguments: { message: 'test' } }],
    ['item/completed', { id: 'tool-1', type: 'mcpToolCall', server: 'control', tool: 'team_send_message', arguments: {}, status: 'completed', result: { content: 'sent' } }],
  ] as const) {await a.native.command({ kind: 'notify', method, params: { ...native, item } })}
  await a.native.command({ kind: 'notify', method: 'thread/tokenUsage/updated', params: { ...native, tokenUsage: { last: { inputTokens: 0 } } } })
  await a.native.command({ kind: 'finish', ...native }); assert((await queued).ok)
  const starts = a.native.writes.filter(frame => frame.method === 'turn/start')
  assert.deepEqual((starts[1]!.params as Record<string, unknown>).input, [{ type: 'text', text: 'message 2', text_elements: [] }])
  await a.native.command({ kind: 'finish', ...ref(a.native, 'turn-2'), status: 'failed' })
  await b.native.command({ kind: 'finish', ...ref(b.native) })
  await until(() => a.events.filter(event => event.kind === 'result').length === 2 && b.events.some(event => event.kind === 'result'))
  assert(a.events.every(event => event.sessionRef === 'runtime-A')); assert(b.events.every(event => event.sessionRef === 'runtime-B'))
  assert.deepEqual(a.events.filter(event => event.kind === 'result').map(event => [event.operationRef, event.outcome]), [['op-1', 'succeeded'], ['op-2', 'failed']])
  assert(a.events.some(event => event.kind === 'tool' && event.name === 'mcp__control__team_send_message'))
  assert(a.events.some(event => event.kind === 'tool-result' && event.toolRef === 'tool-1'))
  const usage = a.events.find(event => event.kind === 'usage'); assert(usage?.kind === 'usage'); assert.equal(usage.inputTokens, 0); assert.equal(usage.outputTokens, undefined)
})

test('canonical permission replies remain independent of queue, one-turn scoped and stale after native terminal', async t => {
  const a = await opened(t); await a.driver.submit(input()); const queued = a.driver.submit(input(2)); const native = ref(a.native)
  await a.native.command({ kind: 'approval', requestId: 'approval-A', method: 'item/commandExecution/requestApproval', params: { ...native, itemId: 'command-A', command: 'test' } })
  await until(() => a.events.some(event => event.kind === 'interaction'))
  const interaction = a.events.find(event => event.kind === 'interaction'); assert(interaction?.kind === 'interaction')
  assert.deepEqual(await a.driver.respondToInteraction(interaction.interactionRef, { kind: 'question', answers: {} }), { ok: false, code: 'unsupported' })
  assert.deepEqual(await a.driver.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined })
  await a.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 'approval-A')
  assert.deepEqual(a.native.writes.find(frame => frame.id === 'approval-A')?.result, { decision: 'accept' })
  assert.deepEqual(await a.driver.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' })
  await a.native.command({ kind: 'approval', requestId: 'pending-A', method: 'item/fileChange/requestApproval', params: { ...native, itemId: 'edit-A' } })
  await until(() => a.events.filter(event => event.kind === 'interaction').length === 2)
  const pending = a.events.filter(event => event.kind === 'interaction').at(-1); assert(pending?.kind === 'interaction')
  await a.native.command({ kind: 'finish', ...native }); assert((await queued).ok)
  assert.deepEqual(await a.driver.respondToInteraction(pending.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' })
  assert.equal(a.native.writes.some(frame => frame.id === 'pending-A'), false)
  await a.native.command({ kind: 'finish', ...ref(a.native, 'turn-2') })
})

test('a delayed interrupt A cannot stop queued B or a neighboring session and ACK is not terminal', async t => {
  const a = await opened(t); const neighbor = await opened(t, 'runtime-B')
  await a.driver.submit(input()); await neighbor.driver.submit(input()); const native = ref(a.native)
  await a.native.command({ kind: 'hold-interrupts' })
  const queued = a.driver.submit(input(2)); const interrupted = a.driver.interrupt('op-1')
  await a.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.method === 'turn/interrupt')
  assert.equal(a.native.writes.filter(frame => frame.method === 'turn/start').length, 1)
  assert.equal(a.events.some(event => event.kind === 'result'), false)
  await a.native.command({ kind: 'finish', ...native, status: 'interrupted' })
  assert.deepEqual(await interrupted, { ok: false, code: 'stale' }); assert((await queued).ok)
  await a.native.command({ kind: 'release-interrupts' })
  assert.deepEqual(a.native.writes.find(frame => frame.method === 'turn/interrupt')?.params, native)
  assert.equal(neighbor.native.writes.some(frame => frame.method === 'turn/interrupt'), false)
  assert.deepEqual(await a.driver.interrupt('op-1'), { ok: false, code: 'stale' })
  await a.native.command({ kind: 'finish', ...native, status: 'interrupted' })
  await a.native.command({ kind: 'finish', ...ref(a.native, 'turn-2') }); await neighbor.native.command({ kind: 'finish', ...ref(neighbor.native) })
  await until(() => a.events.filter(event => event.kind === 'result').length === 2)
  assert.deepEqual(a.events.filter(event => event.kind === 'result').map(event => event.outcome), ['cancelled', 'succeeded'])
})

test('transport loss leaves accepted input unknown, rejects queued input known not sent and never replays', async t => {
  const a = await opened(t); await a.driver.submit(input()); const queued = a.driver.submit(input(2))
  await a.native.command({ kind: 'disconnect' })
  assert.deepEqual(await queued, { ok: false, code: 'unknown', delivery: 'known-not-sent' })
  await until(() => a.events.some(event => event.kind === 'result'))
  assert.deepEqual(a.events.filter(event => event.kind === 'result').map(event => [event.inputId, event.outcome]), [['input-1', 'unknown']])
  assert.equal(a.native.writes.filter(frame => frame.method === 'turn/start').length, 1)
  assert.deepEqual(await a.driver.submit(input(3)), { ok: false, code: 'unavailable', delivery: 'known-not-sent' })
  assert.equal(a.driver.checkpoint().ok, false)
})
