import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectOpenCodeV2NativeTurn } from '../../../../src/opencode.ts'
import type { OpenCodeV2NativeTurnCut } from '../../../../src/opencode.ts'

import { cut, sessionID, assistantID, content, toolInput } from './v2-cut-fixture.ts'

function assistant(value: OpenCodeV2NativeTurnCut) { return value.messages.data.find(row => row.id === assistantID)! }

test('both native dialects retain exact input, text and raw tool facts without inferring product completion', () => {
  for (const pin of ['2.0.0', '2.0.21'] as const) {
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
    value => { value.log.watermark = 50 },
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
  failed.log.events[6]!.data = { sessionID, assistantMessageID: assistantID, id: 'TEST-tool', error }
  const projected = projectOpenCodeV2NativeTurn(failed)
  assert.equal(projected.state, 'succeeded')
  assert.equal(projected.tools[0]?.status, 'error')
})


test('trimmed or absent native history cannot become input-not-delivered pending', () => {
  const value = cut()
  const trimmed = { ...value, beforeCursor: 2, log: { synced: true as const, watermark: 999,
    events: [{ id: 'evt_trimmed', type: 'session.updated', aggregateID: sessionID, seq: 999, data: { sessionID } }] } }
  assert.equal(projectOpenCodeV2NativeTurn(trimmed).state, 'unknown')
  assert.equal(projectOpenCodeV2NativeTurn(trimmed).reason, 'missing_native_log_prefix')
  assert.equal(projectOpenCodeV2NativeTurn({ ...value, log: { synced: true, watermark: null, events: [] } }).state, 'unknown')
})
