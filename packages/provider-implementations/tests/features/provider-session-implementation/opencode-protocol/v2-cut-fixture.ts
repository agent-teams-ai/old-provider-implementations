import type { OpenCodeV2NativeTurnCut } from '../../../../src/opencode.ts'

export const sessionID = 'ses_TESToriginal', nativeInputID = 'msg_TESTinput', assistantID = 'msg_TESTassistant'
export const content = [{ type: 'text', text: '{"accepted":true,"task":{"status":"completed"}}' }]
export const toolInput = { text: 'TEST tool input' }
export function cut(pin: '2.0.0' | '2.0.21' = '2.0.21'): OpenCodeV2NativeTurnCut {
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
      ...(pin === '2.0.21' ? [{ id: 'msg_TEST9', type: 'idle', timeCreated: 9, data: { outcome: 'succeeded' } }] : []),
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
