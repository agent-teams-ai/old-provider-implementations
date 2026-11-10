import type { CodexAppServerToolApprovalRequest } from '../../contracts/codex-approval.ts'
import type { CodexApprovalReply } from './approval-response.ts'
import type { CodexNativeNormalizedEvent } from '../../contracts/codex-events.ts'
import type { CodexRequestContext } from './rpc-types.ts'

export type CodexTurnRef = { readonly threadId: string; readonly turnId: string }
export type CodexTurnOutcome = CodexTurnRef & {
  readonly outcome: 'completed' | 'failed' | 'interrupted' | 'unknown'
  readonly errorMessage?: string
}
export type CodexTurnSubmission = {
  /** Native turn/start receipt, not a task/turn completion or durable input ACK. */
  readonly accepted: Promise<CodexTurnRef>
  readonly completed: Promise<CodexTurnOutcome>
}
export type CodexAppServerEvent = {
  readonly threadId?: string
  readonly turnId?: string
  readonly event: CodexNativeNormalizedEvent
}
export type CodexTurnParams = Readonly<Record<string, unknown>> & { readonly input: readonly unknown[] }
export type CodexApprovalHandler = (
  request: CodexAppServerToolApprovalRequest,
  signal: AbortSignal,
) => Promise<CodexApprovalReply>
export type CodexSessionHooks = {
  readonly request: (method: string, params: unknown, context?: CodexRequestContext) => Promise<unknown>
  readonly capture: (params: Readonly<Record<string, unknown>>) => Record<string, unknown>
  readonly event: (event: CodexAppServerEvent) => void
  readonly item?: (ref: CodexTurnRef, itemId: string) => void
  readonly approve: CodexApprovalHandler
  readonly maxQueuedTurns: number
  readonly maxBufferedNotifications: number
  readonly maxTextBytes: number
}

export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let settle!: (value: T) => void
  let fail!: (error: Error) => void
  const promise = new Promise<T>((resolve, reject) => { settle = resolve; fail = reject })
  void promise.catch(() => {}) // Either receipt may be observed independently; never leave an orphan rejection.
  return { promise, resolve: settle, reject: fail }
}

export async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) {
    void promise.catch(() => {}) // A callback may have synchronously closed its own client before returning.
    return null
  }
  let abort!: () => void
  const stopped = new Promise<null>(resolve => { abort = () => { resolve(null) } })
  signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([promise, stopped]) }
  finally { signal.removeEventListener('abort', abort) }
}
