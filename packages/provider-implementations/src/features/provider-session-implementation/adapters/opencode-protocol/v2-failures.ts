export class ExecutionTransportFailure extends Error {
  readonly code: string
  readonly disposition: 'not_submitted' | 'unknown'
  constructor(code: string, disposition: 'not_submitted' | 'unknown') { super(code); this.code = code; this.disposition = disposition }
}
export const unsubmitted = new WeakSet<object>()
export type V2SessionAbsenceBinding = { sessionId: string; endpoint: string; directory: string; version: '2.0.0' | '2.0.21' }
export const missingSessions = new WeakMap<object, V2SessionAbsenceBinding>()
export function executionSessionIsMissing(error: unknown, expected: V2SessionAbsenceBinding): boolean {
  if (error === null || typeof error !== 'object') {return false}
  const wrapped = error as { name?: unknown; reason?: unknown; cause?: unknown }
  const binding = missingSessions.get(error) ?? (wrapped.name === 'ClientError' && wrapped.reason === 'Transport'
    && wrapped.cause !== null && typeof wrapped.cause === 'object' ? missingSessions.get(wrapped.cause) : undefined)
  return binding !== undefined && binding.sessionId === expected.sessionId && binding.endpoint === expected.endpoint
    && binding.directory === expected.directory && binding.version === expected.version
}
export function executionWasNotSubmitted(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {return false}
  if (unsubmitted.has(error)) {return true}
  // Both exact Promise clients wrap a fetch rejection in ClientError(Transport)
  // with its original cause. Trust only the privately minted cause identity.
  const wrapped = error as { name?: unknown; reason?: unknown; cause?: unknown }
  return wrapped.name === 'ClientError' && wrapped.reason === 'Transport' &&
    wrapped.cause !== null && typeof wrapped.cause === 'object' && unsubmitted.has(wrapped.cause)
}
export function executionAssert(value: boolean, code = 'invalid_response'): asserts value {
  if (!value) {throw new ExecutionTransportFailure(code, 'not_submitted')}
}
