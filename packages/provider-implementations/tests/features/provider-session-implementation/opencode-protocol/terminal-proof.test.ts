import assert from 'node:assert/strict'
import { test } from 'node:test'
import { qualifyOpenCodeV1BoundTerminalProof } from '../../../../src/opencode.ts'
import type { OpenCodeCanonicalMessage, OpenCodeV1TerminalEvidence } from '../../../../src/opencode.ts'

const binding = { nativeSessionId: 'session_A', workspacePath: '/TEST/original', hostKey: 'TEST-host',
  runId: 'TEST-run', profileRootKey: 'TEST-profile' }
function message(id: string, role: 'user' | 'assistant', time: number): OpenCodeCanonicalMessage {
  return { id, parentId: role === 'assistant' ? 'input_A' : null, role, agent: null, providerId: null,
    modelId: null, createdAt: time, completedAt: time + 1, text: role === 'assistant' ? 'done' : 'input',
    reasoningText: '', previewText: null, partTypes: ['text'], reasoningPartCount: 0, toolCalls: [],
    contentBlocks: [], finishReason: role === 'assistant' ? 'stop' : null,
    errorName: null, errorMessage: null, hasError: false }
}
function evidence(): OpenCodeV1TerminalEvidence {
  return { sessionId: 'session_A', messages: [message('input_A', 'user', 1), message('answer_A', 'assistant', 2)],
    messageSessionIds: ['session_A', 'session_A'], complete: true, interactionsSettled: true, diagnostics: [],
    authority: { hostKey: 'TEST-host', runId: 'TEST-run', profileRootKey: 'TEST-profile', projectPath: '/TEST/original' } }
}

// A plausible completion from another session, user turn or workspace must never qualify recovery.
test('terminal recovery requires exact original session, user anchor, workspace and complete settled evidence', () => {
  const result = qualifyOpenCodeV1BoundTerminalProof(evidence(), binding, 'input_A')
  assert.equal(result.proof?.outcome, 'success')
  assert.equal(result.proof?.assistantMessageId, 'answer_A')
  const negatives: Array<(value: OpenCodeV1TerminalEvidence) => void> = [
    value => { value.complete = false }, value => { value.interactionsSettled = false },
    value => { value.sessionId = 'session_B' }, value => { value.messageSessionIds[1] = 'session_B' },
    value => { value.authority!.projectPath = '/TEST/relocated' }, value => { value.authority!.runId = 'TEST-next-run' },
    value => { value.messages[1]!.parentId = 'input_B' }, value => { value.messages[0]!.id = 'foreign_input' },
    value => { value.messages[1]!.completedAt = null }, value => { value.messages[1]!.finishReason = 'tool-calls' },
    value => { value.messages.push(message('input_B', 'user', 3), message('late_answer_A', 'assistant', 4)); value.messageSessionIds.push('session_A', 'session_A') },
  ]
  for (const alter of negatives) {
    const value = evidence(); alter(value)
    assert.equal(qualifyOpenCodeV1BoundTerminalProof(value, binding, 'input_A').proof, null)
  }
})

test('unsettled tool and unknown finish stay unknown; native aborted error remains a technical outcome', () => {
  const value = evidence()
  value.messages[1]!.toolCalls.push({ callId: 'tool_A', toolName: 'TEST', title: null, status: 'running',
    input: {}, output: null, outputText: null, outputPreview: null, startedAt: 2, completedAt: null, isError: false })
  assert.equal(qualifyOpenCodeV1BoundTerminalProof(value, binding, 'input_A').proof, null)
  value.messages[1]!.toolCalls = []
  Object.assign(value.messages[1]!, { errorName: 'MessageAbortedError', finishReason: null, hasError: true })
  assert.equal(qualifyOpenCodeV1BoundTerminalProof(value, binding, 'input_A').proof?.outcome, 'error')
})
