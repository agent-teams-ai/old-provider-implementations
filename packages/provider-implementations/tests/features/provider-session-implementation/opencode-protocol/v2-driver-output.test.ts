import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EventPayload } from '@agent-teams/provider-session-contracts'
import { OpenCodeV2DriverOutput } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-output.ts'
import { projectOpenCodeV2NativeTurn } from '../../../../src/opencode.ts'
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
