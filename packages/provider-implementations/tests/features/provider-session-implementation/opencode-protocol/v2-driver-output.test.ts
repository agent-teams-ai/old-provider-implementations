import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EventPayload } from '@agent-teams/provider-session-contracts'
import { OpenCodeV2DriverOutput } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-output.ts'
import { projectOpenCodeV2NativeTurn } from '../../../../src/opencode.ts'
import type { OpenCodeV2NativeTurnCut } from '../../../../src/opencode.ts'
import { cut, assistantID } from './v2-cut-fixture.ts'

test('canonical native output keeps native message/block/tool attribution and never promotes product-looking tool content', () => {
  const events: EventPayload[] = [], output = new OpenCodeV2DriverOutput(event => { events.push(event) })
  const value = cut(), turn = projectOpenCodeV2NativeTurn(value)
  output.accept(value, turn); output.accept(value, turn)
  assert.deepEqual(events.map(event => event.kind), ['text', 'tool', 'tool-result'])
  assert.deepEqual(events[0], { kind: 'text', messageRef: assistantID, block: 0, text: 'TEST reply', phase: 'complete' })
  const tool = events[1]; assert.ok(tool?.kind === 'tool')
  assert.equal(tool.toolRef, assistantID + ':TEST-tool')
  assert.equal(tool.name, 'agent-teams_task_done')
  assert.equal(events.some(event => event.kind === 'result'), false)
  assert.equal(events.some(event => 'task' in event || 'receipt' in event), false)
})

test('unqualified lineage never emits canonical text/tool output', () => {
  const events: EventPayload[] = [], output = new OpenCodeV2DriverOutput(event => { events.push(event) })
  const value = cut(); value.messages.data.splice(1, 1)
  const turn = projectOpenCodeV2NativeTurn(value); assert.equal(turn.state, 'unknown')
  output.accept(value, turn); assert.deepEqual(events, [])
})

function completedTool(metadata: unknown, name = 'shell', pin: OpenCodeV2NativeTurnCut['pin'] = '2.1.4', providerExecuted = false) {
  const value = cut(pin)
  const parts = value.messages.data.find(row => row.id === assistantID)!.data.content as Record<string, unknown>[]
  const tool = parts.find(part => part.type === 'tool')!
  tool.name = name; tool.executed = providerExecuted
  ;(tool.state as Record<string, unknown>).metadata = metadata
  value.log.events[4]!.data = { ...value.log.events[4]!.data, name }
  for (const index of [5, 6]) { value.log.events[index]!.data = { ...value.log.events[index]!.data, executed: providerExecuted } }
  return value
}
function canonicalOutput(value: OpenCodeV2NativeTurnCut) {
  const events: EventPayload[] = [], output = new OpenCodeV2DriverOutput(event => { events.push(event) })
  const turn = projectOpenCodeV2NativeTurn(value)
  output.accept(value, turn); output.accept(value, turn)
  return { turn, events, results: events.filter(event => event.kind === 'tool-result') }
}

test('2.1.4 shell nonzero native exit is an error result while preserving completed native facts and content', () => {
  for (const exit of [0, 7]) {
    const value = completedTool({ status: 'completed', truncated: false, exit })
    const { turn, results } = canonicalOutput(value)
    assert.equal(turn.state, 'succeeded')
    assert.equal(turn.tools[0]?.status, 'completed')
    assert.equal(results.length, 1)
    assert.equal(results[0]?.isError, exit !== 0)
    assert.deepEqual(results[0]?.content, turn.tools[0]?.content)
  }
})

test('missing shell exit keeps the native completed result and never parses arbitrary text as an exit code', () => {
  for (const metadata of [undefined, null, {}, { status: 'completed', truncated: false }, { exit: 0 }]) {
    const value = completedTool(metadata)
    const content = [{ type: 'text', text: 'Exited with code 7' }]
    const parts = value.messages.data.find(row => row.id === assistantID)!.data.content as Record<string, unknown>[]
    ;(parts.find(part => part.type === 'tool')!.state as Record<string, unknown>).content = content
    value.log.events[6]!.data = { ...value.log.events[6]!.data, content }
    const { turn, results } = canonicalOutput(value)
    assert.equal(turn.state, 'succeeded')
    assert.equal(results[0]?.isError, false)
    assert.deepEqual(results[0]?.content, content)
  }
})

test('malformed explicit native shell exit cannot produce a successful canonical tool result', () => {
  for (const metadata of ['invalid', [], ...[undefined, null, '7', false, 1.5, NaN, Infinity, 2 ** 53, {}].map(exit => ({ exit }))]) {
    const { turn, events } = canonicalOutput(completedTool(metadata))
    assert.equal(turn.state, 'unknown')
    assert.equal(turn.reason, 'invalid_shell_exit_metadata')
    assert.deepEqual(events, [])
  }
  let read = false
  const metadata = Object.defineProperty({}, 'exit', { get() { read = true; return 0 } })
  assert.equal(canonicalOutput(completedTool(metadata)).turn.state, 'unknown')
  assert.equal(read, false)
})

test('native shell exit semantics are not applied to MCP names, provider-executed tools or older dialects', () => {
  for (const value of [completedTool({ exit: 7 }, 'agent-teams_shell'), completedTool({ exit: 'bad' }, 'mcp_shell'),
    completedTool({ exit: 7 }, 'shell', '2.1.4', true),
    completedTool({ exit: 7 }, 'shell', '2.0.21'), completedTool({ exit: 7 }, 'shell', '2.0.0')]) {
    const { turn, results } = canonicalOutput(value)
    assert.equal(turn.state, 'succeeded')
    assert.equal(results[0]?.isError, false)
  }
})
