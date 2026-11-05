import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectOpenCodeV2NativeTurn } from '../../../../src/opencode.ts'
import type { OpenCodeV2NativeTurnCut } from '../../../../src/opencode.ts'

import { cut, sessionID, assistantID, content, toolInput } from './v2-cut-fixture.ts'

function assistant(value: OpenCodeV2NativeTurnCut) { return value.messages.data.find(row => row.id === assistantID)! }

test('both native dialects retain exact input, text and raw tool facts without inferring product completion', () => {
  for (const pin of ['2.0.0', '2.0.21', '2.1.4'] as const) {
    const projected = projectOpenCodeV2NativeTurn(cut(pin))
    assert.equal(projected.state, 'succeeded')
    assert.equal(projected.text, 'TEST reply')
    assert.deepEqual(projected.assistantMessageIds, [assistantID])
    assert.deepEqual(projected.tools, [{ assistantMessageId: assistantID, toolCallId: 'TEST-tool',
      toolName: 'agent-teams_task_done', status: 'completed', executed: false,
      input: toolInput, content, error: null, metadata: null }])
    assert.equal('visibleReplies' in projected, false)
    assert.equal('kind' in projected.tools[0]!, false)
  }
})

test('2.1.4 requires a native idle snapshot matching the durable execution terminal', () => {
  const missing = cut('2.1.4')
  missing.messages.data = missing.messages.data.filter(item => item.type !== 'idle')
  assert.equal(projectOpenCodeV2NativeTurn(missing).state, 'unknown')
  assert.equal(projectOpenCodeV2NativeTurn(missing).reason, 'terminal_snapshot_mismatch')
})

test('completed step/tool does not imply native execution terminal', () => {
  const value = cut()
  value.log.events.pop(); value.log.watermark = 8
  const projected = projectOpenCodeV2NativeTurn(value)
  assert.equal(projected.state, 'pending')
  assert.equal(projected.reason, 'no_execution_terminal')
})

test('gaps, mixed sessions, duplicate delivery and mismatching snapshots remain unknown', () => {
  const negatives: Array<(value: OpenCodeV2NativeTurnCut) => void> = [
    value => { value.messages.next = 'unread_page' },
    value => { value.log.events[4]!.seq = 50 },
    value => { value.log.watermark = 8 },
    value => { value.log.watermark = Number.NaN },
    value => { value.log.watermark = Number.POSITIVE_INFINITY },
    value => { value.log.events[4]!.data = { ...value.log.events[4]!.data, sessionID: 'ses_foreign' } },
    value => { value.log.events[4]!.type = 'session.inbox.delivered' },
    value => { value.messages.data[0]!.data = { ...value.messages.data[0]!.data, text: 'foreign input' } },
    value => { value.log.events[7]!.data = { ...value.log.events[7]!.data, text: 'foreign text' } },
    value => { value.messages.data.pop() },
    value => { const row = assistant(value); row.data = { ...row.data, time: { completed: NaN } } },
    value => { const parts = assistant(value).data.content as unknown[]; parts.push(parts[1]) },
    value => { value.log.events[6]!.data = { ...value.log.events[6]!.data, content: [{ type: 'text', text: 'foreign result' }] } },
  ]
  for (const alter of negatives) {
    const value = cut(); alter(value)
    const projected = projectOpenCodeV2NativeTurn(value)
    assert.equal(projected.state, 'unknown')
    assert.deepEqual(projected.tools, [])
  }
})


test('native log sync may safely include filtered bus sequence beyond final session event', () => {
  const value = cut()
  value.log.watermark = 50
  assert.equal(projectOpenCodeV2NativeTurn(value).state, 'succeeded')
})

test('only adjacent clean retry lineage can reuse one native assistant identity', () => {
  const value = cut()
  const original = value.log.events[3]!
  const retry = { ...original, id: 'evt_retry', type: 'session.retry.scheduled', seq: 4,
    data: { sessionID, assistantMessageID: assistantID, attempt: 2, at: 100, error: { type: 'TEST retry', message: 'TEST' } } }
  value.log.events.splice(4, 0, retry, { ...original, id: 'evt_retry_start', seq: 5 })
  for (const row of value.log.events.slice(6)) {row.seq += 2}
  value.log.watermark = 11
  value.messages.data[2]!.id = 'msg_TEST9' // Native event ID remains original terminal ID after fixture sequence shift.
  assert.equal(projectOpenCodeV2NativeTurn(value).state, 'succeeded')
  const wrong = structuredClone(value)
  wrong.log.events[4]!.data = { ...wrong.log.events[4]!.data, attempt: 9 }
  assert.equal(projectOpenCodeV2NativeTurn(wrong).state, 'unknown')
})

test('native tool running and failure remain technical observations', () => {
  const running = cut()
  running.log.events = running.log.events.slice(0, 6); running.log.watermark = 5
  assistant(running).data = { ...assistant(running).data, content: [{ type: 'tool', id: 'TEST-tool', name: 'agent-teams_task_done', executed: false,
    state: { status: 'running', input: toolInput } }] }
  const pending = projectOpenCodeV2NativeTurn(running)
  assert.equal(pending.state, 'pending')
  assert.equal(pending.tools[0]?.status, 'running')
  const failed = cut(), error = { type: 'TEST tool error', message: 'TEST failure' }
  assistant(failed).data = { ...assistant(failed).data, content: [{ type: 'tool', id: 'TEST-tool', name: 'agent-teams_task_done', executed: false,
    state: { status: 'error', input: toolInput, error } }] }
  failed.log.events[6]!.type = 'session.tool.failed'
  failed.log.events[6]!.data = { sessionID, assistantMessageID: assistantID, id: 'TEST-tool', error, executed: false }
  const projected = projectOpenCodeV2NativeTurn(failed)
  assert.equal(projected.state, 'succeeded')
  assert.equal(projected.tools[0]?.status, 'error')
})


test('tool execution evidence combines durable called and terminal flags without losing effects', () => {
  for (const pin of ['2.0.0', '2.0.21', '2.1.4'] as const) {
    // Native message-updater cumulatively ORs executed bits. If Called says
    // executed=true, a later false terminal cannot erase that evidence.
    const calledExecuted = cut(pin)
    calledExecuted.log.events[5]!.data.executed = true
    const parts = assistant(calledExecuted).data.content as Record<string, unknown>[]
    const tool = parts.find(part => part.type === 'tool')!
    tool.executed = true
    const accepted = projectOpenCodeV2NativeTurn(calledExecuted)
    assert.equal(accepted.state, 'succeeded')
    assert.equal(accepted.tools[0]?.executed, true)

    // Both log and projected message must agree with the OR of the durable
    // Called/Success bits; a false tool snapshot must not claim no execution.
    const falseSnapshot = structuredClone(calledExecuted)
    const falseParts = assistant(falseSnapshot).data.content as Record<string, unknown>[]
    falseParts.find(part => part.type === 'tool')!.executed = false
    const inconsistent = projectOpenCodeV2NativeTurn(falseSnapshot)
    assert.equal(inconsistent.state, 'unknown')
    assert.equal(inconsistent.reason, 'tool_success_snapshot_mismatch')
    assert.deepEqual(inconsistent.tools, [])

    const terminalExecuted = cut(pin)
    terminalExecuted.log.events[6]!.data.executed = true
    const contradicted = projectOpenCodeV2NativeTurn(terminalExecuted)
    assert.equal(contradicted.state, 'unknown')
    assert.equal(contradicted.reason, 'tool_success_snapshot_mismatch')
  }
})

test('failed native tool cannot erase actual execution from durable events', () => {
  const makeFailure = () => {
    const value = cut()
    const error = { type: 'TEST failed', message: 'TEST rejected result' }
    assistant(value).data = { ...assistant(value).data, content: [{
      type: 'tool', id: 'TEST-tool', name: 'agent-teams_task_done', executed: false,
      state: { status: 'error', input: toolInput, error },
    }] }
    value.log.events[6]!.type = 'session.tool.failed'
    value.log.events[6]!.data = { sessionID, assistantMessageID: assistantID, id: 'TEST-tool',
      error, executed: false }
    return value
  }
  const base = makeFailure()
  assert.equal(projectOpenCodeV2NativeTurn(base).tools[0]?.executed, false)
  for (const index of [5, 6]) {
    const inconsistent = makeFailure()
    inconsistent.log.events[index]!.data.executed = true
    const projected = projectOpenCodeV2NativeTurn(inconsistent)
    assert.equal(projected.state, 'unknown')
    assert.equal(projected.reason, 'tool_failure_snapshot_mismatch')
    assert.deepEqual(projected.tools, [])
  }
  const cumulative = makeFailure()
  cumulative.log.events[5]!.data.executed = true
  ;(assistant(cumulative).data.content as Record<string, unknown>[])[0]!.executed = true
  const projected = projectOpenCodeV2NativeTurn(cumulative)
  assert.equal(projected.state, 'succeeded')
  assert.equal(projected.tools[0]?.status, 'error')
  assert.equal(projected.tools[0]?.executed, true)
})

test('trimmed or absent native history cannot become input-not-delivered pending', () => {
  const value = cut()
  const trimmed = { ...value, beforeCursor: 2, log: { synced: true as const, watermark: 999,
    events: [{ id: 'evt_trimmed', type: 'session.updated', aggregateID: sessionID, seq: 999, data: { sessionID } }] } }
  assert.equal(projectOpenCodeV2NativeTurn(trimmed).state, 'unknown')
  assert.equal(projectOpenCodeV2NativeTurn(trimmed).reason, 'missing_native_log_prefix')
  assert.equal(projectOpenCodeV2NativeTurn({ ...value, log: { synced: true, watermark: null, events: [] } }).state, 'unknown')
})
