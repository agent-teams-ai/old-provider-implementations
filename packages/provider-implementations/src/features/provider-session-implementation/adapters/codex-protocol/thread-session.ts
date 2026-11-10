import type { CodexAppServerRequest, CodexAppServerToolApprovalRequest } from '../../contracts/codex-approval.ts'
import { normalizeCodexAppServerApprovalRequest } from './approval-request.ts'
import { encodeCodexApprovalResponse } from './approval-response.ts'
import { CodexNotificationMapper, nativeTurnError, nativeTurnId, nativeTurnOutcome } from './notification-mapper.ts'
import { CodexProtocolError } from './rpc-types.ts'
import type { CodexServerReply } from './rpc-types.ts'
import { deferred, untilAbort } from './session-types.ts'
import type { CodexSessionHooks, CodexTurnOutcome, CodexTurnParams, CodexTurnRef, CodexTurnSubmission } from './session-types.ts'
import { record, string } from './wire-frames.ts'

type ModelSelection = Readonly<{ model: string; modelProvider: string; cwd: string; reasoningEffort?: string | null; serviceTier?: string | null }>
type QueuedNotification = { method: string; params: Record<string, unknown> }
type Turn = {
  readonly params: Record<string, unknown>
  readonly accepted: ReturnType<typeof deferred<CodexTurnRef>>
  readonly completed: ReturnType<typeof deferred<CodexTurnOutcome>>
  readonly lifecycle: AbortController
  readonly approvals: AbortController
  readonly mapper: CodexNotificationMapper
  readonly buffered: QueuedNotification[]
  readonly items: Set<string>
  readonly cleanup: () => void
  ref?: CodexTurnRef
  cancelRequested: boolean
  interrupt?: Promise<unknown>
}
function approvalTargetsTurn(approval: CodexAppServerToolApprovalRequest, ref: CodexTurnRef, items: ReadonlySet<string>): boolean {
  return approval.turnId === ref.turnId || (approval.turnId === null && approval.itemId !== null && items.has(approval.itemId))
}

/** Volatile sequencing for one native thread. Durable scheduling and recovery remain runtime-owned. */
export class CodexThreadSession {
  readonly threadId: string
  /** Captured native thread/start reply; missing metadata never becomes selected-model proof. */
  readonly modelSelection: ModelSelection | undefined
  private readonly hooks: CodexSessionHooks
  private readonly queued: Turn[] = []
  private active: Turn | undefined
  private ended = false

  constructor(threadId: string, hooks: CodexSessionHooks, modelSelection?: ModelSelection) {
    this.threadId = threadId
    this.modelSelection = modelSelection ? Object.freeze({ ...modelSelection }) : undefined
    this.hooks = hooks
  }

  submitTurn(params: CodexTurnParams, signal?: AbortSignal): CodexTurnSubmission {
    const cancelled = (): boolean => signal?.aborted === true
    if (this.ended || cancelled()) {throw new CodexProtocolError('codex.protocol.session-closed', 'not-sent')}
    if (this.queued.length >= this.hooks.maxQueuedTurns) {throw new CodexProtocolError('codex.protocol.turn-queue-limit', 'not-sent')}
    if (Object.hasOwn(params, 'threadId') || !Array.isArray(params.input) || !params.input.length) {
      throw new CodexProtocolError('codex.protocol.invalid-turn-params', 'not-sent')
    }
    const cancel = (): void => { this.cancel(turn) }
    const turn: Turn = {
      params: this.hooks.capture(params), accepted: deferred(), completed: deferred(),
      lifecycle: new AbortController(), approvals: new AbortController(),
      mapper: new CodexNotificationMapper(this.hooks.maxTextBytes), buffered: [], items: new Set(),
      cancelRequested: false, cleanup: () => signal?.removeEventListener('abort', cancel),
    }
    signal?.addEventListener('abort', cancel, { once: true })
    this.queued.push(turn)
    if (cancelled()) {cancel()}
    this.advance()
    return { accepted: turn.accepted.promise, completed: turn.completed.promise }
  }

  interrupt(ref: CodexTurnRef): Promise<unknown> {
    const turn = this.active
    if (!turn?.ref || ref.threadId !== this.threadId || ref.turnId !== turn.ref.turnId || this.ended) {
      return Promise.reject(new CodexProtocolError('codex.protocol.stale-turn', 'not-sent'))
    }
    if (turn.interrupt) {return turn.interrupt}
    turn.approvals.abort()
    const target = { ...turn.ref } // Never read a later active turn while dispatching this control.
    turn.interrupt = this.hooks.request('turn/interrupt', target, {
      signal: turn.lifecycle.signal,
      beforeWrite: () => this.active === turn && turn.ref?.turnId === target.turnId,
    })
    return turn.interrupt
  }

  receive(method: string, params: Record<string, unknown>): boolean {
    const turn = this.active
    if (!turn || this.ended) {return false}
    if (!turn.ref) {
      if (turn.buffered.length >= this.hooks.maxBufferedNotifications) {
        this.close(new CodexProtocolError('codex.protocol.notification-limit'))
        return false
      }
      turn.buffered.push({ method, params })
      return true
    }
    if (nativeTurnId(params) !== turn.ref.turnId) {return false}
    const nestedItemId = record(params.item)?.id
    if (params.itemId !== undefined && nestedItemId !== undefined && params.itemId !== nestedItemId) {return false}
    const itemId = string(params.itemId) ?? string(record(params.item)?.id)
    if (itemId !== null) {
      turn.items.add(itemId)
      if (turn.items.size > 256) {throw new CodexProtocolError('codex.protocol.item-limit')}
      this.hooks.item?.({ ...turn.ref }, itemId)
      if (!this.isOpen()) {return true}
    }
    const ref = turn.ref
    const events = turn.mapper.map(method, params)
    // Commit the native terminal before external projection can synchronously dispose the client.
    if (method === 'turn/completed') {this.finish(turn, params)}
    for (const event of events) {this.hooks.event({ ...ref, event })}
    return true
  }

  async approve(request: CodexAppServerRequest, signal: AbortSignal): Promise<CodexServerReply | null> {
    const turn = this.active
    if (!turn || this.ended) {return this.rejectApproval()}
    if (!turn.ref) {
      try {
        const ready = await untilAbort(turn.accepted.promise, AbortSignal.any([signal, turn.lifecycle.signal]))
        if (!ready) {return null}
      } catch { return null }
    }
    const approval = normalizeCodexAppServerApprovalRequest(request)
    if (!approval || !turn.ref || this.active !== turn || approval.threadId !== this.threadId) {return this.rejectApproval()}
    // Older native approvals lack turnId. Require independent item attribution from this exact turn.
    if (!approvalTargetsTurn(approval, turn.ref, turn.items)) {
      return this.rejectApproval()
    }
    const scope = AbortSignal.any([signal, turn.lifecycle.signal, turn.approvals.signal])
    const cancelled = (): boolean => scope.aborted
    if (cancelled()) {return null}
    try {
      const reply = await untilAbort(this.hooks.approve(approval, scope), scope)
      if (!reply || cancelled() || this.active !== turn) {return null}
      return { result: encodeCodexApprovalResponse(request, reply).result, signal: scope }
    } catch {
      if (cancelled() || this.active !== turn) {return null}
      return { error: { code: -32000, message: 'codex.protocol.request-rejected' }, signal: scope }
    }
  }

  close(error = new CodexProtocolError('codex.protocol.session-closed')): void {
    if (this.ended) {return}
    this.ended = true
    const active = this.active
    this.active = undefined
    if (active) {
      this.rejectTurn(active, error)
    }
    for (const queued of this.queued.splice(0)) {this.rejectTurn(queued, new CodexProtocolError(error.code, 'not-sent'))}
    if (active) {for (const event of active.mapper.flushPending()) {
      try { this.hooks.event({ threadId: this.threadId, ...(active.ref ? { turnId: active.ref.turnId } : {}), event }) }
      catch { /* A closed projection sink cannot prevent request/queue settlement. */ }
    }}
  }

  private advance(): void {
    if (this.ended || this.active) {return}
    const turn = this.queued.shift()
    if (!turn) {return}
    this.active = turn
    void this.start(turn)
  }
  private isOpen(): boolean { return !this.ended }

  private async start(turn: Turn): Promise<void> {
    try {
      const result = record(await this.hooks.request('turn/start', { ...turn.params, threadId: this.threadId }, { signal: turn.lifecycle.signal }))
      if (this.active !== turn || this.ended) {return}
      const native = record(result?.turn)
      const turnId = string(native?.id)
      if (turnId === null) {throw new CodexProtocolError('codex.protocol.missing-turn-id')}
      turn.ref = { threadId: this.threadId, turnId }
      turn.accepted.resolve(turn.ref)
      for (const notification of turn.buffered.splice(0)) {
        if (this.active !== turn || !this.receive(notification.method, notification.params)) {this.unattributed(notification)}
      }
      if (turn.cancelRequested && this.active === turn) {this.cancel(turn)}
    } catch (error) {
      if (this.active === turn && !this.ended) {this.close(error instanceof CodexProtocolError ? error : new CodexProtocolError('codex.protocol.turn-start-failed'))}
    }
  }

  private finish(turn: Turn, params: Record<string, unknown>): void {
    if (this.active !== turn || !turn.ref) {return}
    const outcome = nativeTurnOutcome(params)
    const errorMessage = nativeTurnError(params)
    turn.cleanup()
    this.active = undefined
    turn.completed.resolve({ ...turn.ref, outcome, ...(errorMessage !== undefined ? { errorMessage } : {}) })
    // Revocation invokes external abort callbacks synchronously. Commit the known
    // terminal first so they cannot erase it or make a targeted control look unknown.
    turn.lifecycle.abort()
    turn.approvals.abort()
    if (outcome === 'unknown') {this.close(new CodexProtocolError('codex.protocol.unknown-turn-outcome'))}
    else {this.advance()}
  }

  private cancel(turn: Turn): void {
    turn.cancelRequested = true
    turn.approvals.abort()
    const queued = this.queued.indexOf(turn)
    if (queued !== -1) {
      this.queued.splice(queued, 1)
      this.rejectTurn(turn, new CodexProtocolError('codex.protocol.cancelled-before-dispatch', 'not-sent'))
    } else if (this.active === turn && turn.ref) {
      void this.interrupt(turn.ref).catch((error: unknown) => {
        if (this.active === turn) {this.close(error instanceof CodexProtocolError ? error : new CodexProtocolError('codex.protocol.interrupt-failed'))}
      })
    }
  }

  private rejectTurn(turn: Turn, error: CodexProtocolError): void {
    turn.cleanup()
    turn.lifecycle.abort()
    turn.approvals.abort()
    turn.accepted.reject(error)
    turn.completed.reject(error)
  }

  private rejectApproval(): CodexServerReply {
    return { error: { code: -32001, message: 'codex.protocol.unattributed-approval' } }
  }

  private unattributed(notification: QueuedNotification): void {
    const turnId = nativeTurnId(notification.params)
    this.hooks.event({ threadId: this.threadId, ...(turnId !== null ? { turnId } : {}), event: { type: 'unsupported_raw_event', rawType: notification.method, payload: notification.params } })
  }
}
