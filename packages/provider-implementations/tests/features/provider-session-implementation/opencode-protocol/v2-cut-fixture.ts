import type { OpenCodeV2NativeTurnCut } from '../../../../src/opencode.ts'

export const sessionID = 'ses_TESToriginal', nativeInputID = 'msg_TESTinput', assistantID = 'msg_TESTassistant'
export const content = [{ type: 'text', text: '{"accepted":true,"task":{"status":"completed"}}' }]
export const toolInput = { text: 'TEST tool input' }
export function cut(pin: '2.0.0' | '2.0.21' | '2.1.4' = '2.0.21'): OpenCodeV2NativeTurnCut {
  const event = (type: string, seq: number, data: Record<string, unknown> = {}) =>
    ({ id: `evt_TEST${seq}`, type, seq, aggregateID: sessionID, data: { sessionID, ...data } })
  const assistantMessageID = assistantID
  return { pin, sessionID, nativeInputID, originalText: 'TEST input', beforeCursor: 0,
    messages: { previous: null, next: null, data: [
      { id: nativeInputID, type: 'user', timeCreated: 1, data: { id: nativeInputID, type: 'user', text: 'TEST input' } },
      { id: assistantID, type: 'assistant', timeCreated: 3, data: { id: assistantID, type: 'assistant', finish: 'stop',
        time: { created: 3, completed: 9 }, content: [{ type: 'text', text: 'TEST reply' },
          { type: 'tool', id: 'TEST-tool', name: 'agent-teams_task_done', executed: false,
            state: { status: 'completed', input: toolInput, content } }] } },
      ...(pin !== '2.0.0' ? [{ id: 'msg_TEST9', type: 'idle', timeCreated: 9, data: { outcome: 'succeeded' } }] : []),
    ] },
    log: { synced: true, watermark: 9, events: [
      event('session.created', 0), event('session.execution.started', 1), event('session.inbox.delivered', 2, { inboxID: nativeInputID }),
      event('session.step.started', 3, { assistantMessageID, agent: 'TEST-agent', model: { providerID: 'TEST-provider', id: 'TEST-model' } }),
      event('session.tool.input.started', 4, { assistantMessageID, id: 'TEST-tool', name: 'agent-teams_task_done' }),
      event('session.tool.called', 5, { assistantMessageID, id: 'TEST-tool', input: toolInput, executed: false }),
      event('session.tool.success', 6, { assistantMessageID, id: 'TEST-tool', content, executed: false }),
      event('session.text.ended', 7, { assistantMessageID, text: 'TEST reply' }),
      event('session.step.ended', 8, { assistantMessageID, finish: 'stop' }),
      event('session.execution.succeeded', 9),
    ] },
  }
}

export function editCut(): OpenCodeV2NativeTurnCut {
  const value = cut('2.1.4'), path = '/TEST/native-driver/dirty.txt'
  const input = { path, oldString: 'TEST existing dirty', newString: 'TEST native authored' }
  // Observed from the actual 2.1.4 built-in edit in native-v2-spi-proof.mjs.
  // The input is absolute, while native FileDiff preserves a workspace-relative resource.
  const metadata = { files: [{ file: 'dirty.txt', patch: 'Index: dirty.txt\n===================================================================\n--- dirty.txt\n+++ dirty.txt\n@@ -1,3 +1,3 @@\n TEST clean anchor\n-TEST existing dirty\n+TEST native authored\n TEST unchanged tail\n',
    status: 'modified', additions: 1, deletions: 1 }], truncated: false }
  const parts = value.messages.data.find(row => row.id === assistantID)!.data.content as Record<string, unknown>[]
  const tool = parts.find(row => row.type === 'tool')!
  tool.name = 'edit'; tool.state = { ...(tool.state as object), input, metadata }
  value.log.events[4]!.data = { ...value.log.events[4]!.data, name: 'edit' }
  value.log.events[5]!.data = { ...value.log.events[5]!.data, input }
  value.log.events[6]!.data = { ...value.log.events[6]!.data, metadata }
  return value
}

/** Synthetic original failed native turn, preserving the pinned error/event shape. */
export function rejectedRequestCut(status: 400 | 422): OpenCodeV2NativeTurnCut {
  const value = cut('2.1.4')
  const error = { type: status === 400 ? 'provider.invalid-request' : 'provider.unsupported-operation',
    status, message: 'TEST private provider error' }
  const assistant = value.messages.data.find(row => row.id === assistantID)!
  const { finish: _finish, ...data } = assistant.data
  assistant.data = { ...data, content: [], error }
  value.messages.data.find(row => row.type === 'idle')!.data = { outcome: 'failed' }
  value.log.events = value.log.events.filter(row => row.seq <= 3 || row.seq >= 8)
  const failed = value.log.events.find(row => row.seq === 8)!
  failed.type = 'session.step.failed'; failed.data = { sessionID, assistantMessageID: assistantID, error }
  const ending = value.log.events.find(row => row.seq === 9)!
  ending.type = 'session.execution.failed'; ending.data = { sessionID, error }
  return value
}
