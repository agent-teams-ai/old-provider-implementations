import type { OpenCodeCanonicalMessage } from './canonical-message-types.ts'

export type OpenCodeV1TerminalAuthority = { hostKey: string; runId?: string; profileRootKey: string; projectPath: string }

/** A captured, bounded native read. Completeness and interaction state are explicit. */
export type OpenCodeV1TerminalEvidence = {
  authority?: OpenCodeV1TerminalAuthority
  sessionId: string
  messages: OpenCodeCanonicalMessage[]
  messageSessionIds: Array<string | null>
  /** Transport budget/deadline prevented the first read; no native response was observed. */
  readUnavailable?: boolean
  complete: boolean
  interactionsSettled: boolean
  diagnostics: string[]
}
export type OpenCodeV1TerminalProof = {
  sessionId: string
  runtimePromptMessageId: string
  assistantMessageId: string
  outcome: 'success' | 'error'
  evidence: OpenCodeV1TerminalEvidence
}
const rejectTerminal = (reason: string) => ({ proof: null, diagnostics: [reason] })
function transcriptIdentityProblem(messages: readonly OpenCodeCanonicalMessage[]): string | null {
  const ids = new Set<string>()
  let previousCreated = -1
  for (const message of messages) {
    if (message.id === null || message.id.length === 0 || ids.has(message.id)) { return 'Missing or duplicate native message ID' }
    ids.add(message.id)
    if (message.createdAt === null || !Number.isFinite(message.createdAt) || message.createdAt < 0 || message.createdAt < previousCreated) { return 'Invalid transcript chronology' }
    previousCreated = message.createdAt
    if (message.role !== 'user' && message.role !== 'assistant') { return 'Unknown native message role' }
  }
  return null
}
function settledAssistant(message: OpenCodeCanonicalMessage): boolean {
  return message.completedAt !== null && Number.isFinite(message.completedAt) && message.completedAt >= (message.createdAt ?? Infinity)
}
function settledTool(tool: OpenCodeCanonicalMessage['toolCalls'][number]): boolean {
  return tool.callId !== null && tool.callId.length > 0 && (tool.status === 'completed' || tool.status === 'errored')
    && tool.startedAt !== null && tool.completedAt !== null && Number.isFinite(tool.startedAt) && Number.isFinite(tool.completedAt)
    && tool.completedAt >= tool.startedAt
}
function windowProblem(window: readonly OpenCodeCanonicalMessage[]): string | null {
  for (const message of window) {
    if (!settledAssistant(message)) { return 'Incomplete relevant assistant history' }
    if (!message.toolCalls.every(settledTool)) { return 'Unsettled or unknown native tool disposition' }
  }
  return null
}
function nativeTerminalOutcome(latest: OpenCodeCanonicalMessage): 'success' | 'error' | null {
  if (latest.errorName === 'MessageAbortedError' && latest.finishReason === null) { return 'error' }
  if (!latest.hasError && latest.errorName === null && latest.errorMessage === null && latest.finishReason === 'stop') { return 'success' }
  return null
}
function completeEvidence(evidence: OpenCodeV1TerminalEvidence): boolean {
  return [evidence.complete, evidence.interactionsSettled].every((flag: unknown) => flag === true)
}
function validOriginalIdentity(evidence: OpenCodeV1TerminalEvidence | null | undefined, sessionId: unknown, prompt: unknown): evidence is OpenCodeV1TerminalEvidence {
  return typeof prompt === 'string' && prompt.length > 0 && typeof sessionId === 'string' && sessionId.length > 0 && evidence?.sessionId === sessionId
}
function latestAssistant(window: readonly OpenCodeCanonicalMessage[]): OpenCodeCanonicalMessage | null {
  const latest = window.at(-1)
  return latest !== undefined && latest.role === 'assistant' && latest.id !== null && latest.id.length > 0 ? latest : null
}
export function qualifyOpenCodeV1TerminalProof(
  evidence: OpenCodeV1TerminalEvidence | null | undefined,
  sessionId: string,
  runtimePromptMessageId: string | null | undefined,
): { proof: OpenCodeV1TerminalProof | null; diagnostics: string[] } {
  if (!validOriginalIdentity(evidence, sessionId, runtimePromptMessageId)) { return rejectTerminal('Missing or conflicting native session/prompt identity') }
  if (!completeEvidence(evidence)) { return rejectTerminal('Incomplete transcript or unsettled interaction evidence') }
  const messages = evidence.messages
  if (messages.length !== evidence.messageSessionIds.length || evidence.messageSessionIds.some(id => id !== sessionId)) { return rejectTerminal('Missing or foreign native message session') }
  const identityProblem = transcriptIdentityProblem(messages)
  if (identityProblem !== null) { return rejectTerminal(identityProblem) }
  const anchor = messages.findIndex(message => message.role === 'user' && message.id === runtimePromptMessageId)
  if (anchor < 0) { return rejectTerminal('Persisted exact user anchor missing') }
  const following = messages.slice(anchor + 1), nextUser = following.findIndex(message => message.role === 'user')
  const window = following.slice(0, nextUser < 0 ? undefined : nextUser)
  if (nextUser >= 0 && following.slice(nextUser).some(message => message.parentId === runtimePromptMessageId)) { return rejectTerminal('Native parent crosses user boundary') }
  if (window.some(message => message.parentId !== runtimePromptMessageId)) { return rejectTerminal('Foreign parent in native user window') }
  const latest = latestAssistant(window)
  if (latest === null) { return rejectTerminal('No latest relevant assistant') }
  const unsettled = windowProblem(window)
  if (unsettled !== null) { return rejectTerminal(unsettled) }
  if (!settledAssistant(latest)) { return rejectTerminal('Latest assistant is incomplete or has invalid completion timestamp') }
  const outcome = nativeTerminalOutcome(latest)
  if (outcome === null) { return rejectTerminal(`Unqualified native finish/error: ${latest.finishReason ?? 'none'}/${latest.errorName ?? 'none'}`) }
  return { proof: { sessionId, runtimePromptMessageId: runtimePromptMessageId as string, assistantMessageId: latest.id!, outcome, evidence }, diagnostics: [] }
}

/** Recovery must select the original native/workspace generation before qualifying its turn. */
export function qualifyOpenCodeV1BoundTerminalProof(
  evidence: OpenCodeV1TerminalEvidence | null | undefined,
  binding: { nativeSessionId: string; workspacePath: string; hostKey: string; runId: string; profileRootKey: string },
  runtimePromptMessageId: string,
): { proof: OpenCodeV1TerminalProof | null; diagnostics: string[] } {
  const authority = evidence?.authority
  if (!authority || authority.hostKey !== binding.hostKey || authority.runId !== binding.runId
    || authority.profileRootKey !== binding.profileRootKey || authority.projectPath !== binding.workspacePath) {
    return { proof: null, diagnostics: ['Original native workspace/run/host binding is missing or conflicting'] }
  }
  return qualifyOpenCodeV1TerminalProof(evidence, binding.nativeSessionId, runtimePromptMessageId)
}
