import { OpenCodeInputWindowCapture } from './input-window-capture.ts'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { CloseReceipt, Event, EventPayload, FailureCode, Input, InteractionReply, Reply, Session } from '@agent-teams/provider-session-contracts'
import { bounded, deferred, EventFeed } from '../provider-session-io/io.ts'
import type { DriverPermission, DriverProtocol, DriverSessionConfig, DriverTurn } from './driver-protocol.ts'
import { executionWasNotSubmitted } from './v2-failures.ts'
import { AttachmentFailure, inputFingerprint, prepareAttachments, snapshotInput, validCanonicalInput, validateAttachments } from '../provider-session-io/attachments.ts'

const failure = (code: FailureCode, unsent = false) => ({ ok: false as const, code, ...(unsent ? { delivery: 'known-not-sent' as const } : {}) })
const handoff = (input: Input) => ({ ok: true as const, value: { inputId: input.inputId, operationRef: input.operationRef,
  delivery: 'client-consumed' as const, providerAcceptance: 'unknown' as const } })
type Pending = { capture?: OpenCodeInputWindowCapture; input: Input; nativeId: string; done: ReturnType<typeof deferred<ReturnType<typeof handoff> | ReturnType<typeof failure>>>; handed: boolean; preparing: boolean; interactionsRevoked: boolean; interactionAbort: AbortController; turn?: DriverTurn }
type Interaction = { permission: DriverPermission; owner: Pending; answering: boolean }

/** Volatile bounded native-session consumer. Runtime owns durable operations and recovery. */
export class OpenCodeDriverSession implements Session {
  readonly sessionRef: string
  private readonly config: DriverSessionConfig
  private readonly abort = new AbortController()
  private readonly protocol: DriverProtocol
  private readonly feed: EventFeed<Event>
  private readonly queued: Pending[] = []
  private readonly interactions = new Map<string, Interaction>()
  private readonly settledInteractions = new Set<string>()
  private active: Pending | undefined
  private state: 'open' | 'unavailable' | 'closed' = 'open'
  private wakeup = deferred<void>()
  private readonly loop: Promise<void>
  private closing: Promise<CloseReceipt> | undefined
  private control: Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>> | undefined
  private readonly replies = new Set<Promise<Reply<void>>>()
  private turnEvents = 0
  private turnBytes = 0
  private knownTerminal: Extract<Event, { kind: 'result' }> | undefined
  constructor(config: DriverSessionConfig, createProtocol: (signal: AbortSignal) => DriverProtocol) {
    this.config = config; this.sessionRef = config.binding.sessionId
    this.protocol = createProtocol(this.abort.signal)
    this.feed = new EventFeed(config.limits.outputEvents, config.limits.outputBytes)
    this.loop = this.run()
  }
  submit(supplied: Input) {
    if (!this.isOpen()) {return Promise.resolve(failure('unavailable', true))}
    let input: Input
    try { input = snapshotInput(supplied); validateAttachments(input, this.config.engine, this.config.attachmentModel, this.config.attachments) }
    catch (error) { return Promise.resolve(failure(error instanceof AttachmentFailure ? error.code : 'invalid-config', true)) }
    if (!validCanonicalInput(input, Math.min(this.config.limits.inputBytes, 256 * 1024))) {return Promise.resolve(failure('backpressure', true))}
    if (this.active?.input.inputId === input.inputId || this.active?.input.operationRef === input.operationRef
      || this.queued.some(item => item.input.inputId === input.inputId || item.input.operationRef === input.operationRef)) {return Promise.resolve(failure('stale', true))}
    if (this.queued.length >= this.config.limits.queuedInputs) {return Promise.resolve(failure('backpressure', true))}
    const nativeId = 'msg_' + createHash('sha256').update(JSON.stringify([this.config.trustedBinding,
      this.config.nativeSessionId, this.sessionRef, input.inputId, input.operationRef, ...((input.attachments?.length ?? 0) > 0 ? [inputFingerprint(input)] : [])])).digest('hex')
    const pending: Pending = { input, nativeId, done: deferred(), handed: false, preparing: (input.attachments?.length ?? 0) > 0, interactionsRevoked: false, interactionAbort: new AbortController() }
    this.queued.push(pending); this.wake(); return pending.done.promise
  }
  observe(): AsyncIterable<Event> { return this.feed }
  async checkReadiness(): Promise<Reply<void>> {
    if (!this.isOpen()) {return failure('unavailable')}
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.abort.signal])
    try {
      const ready = await bounded(this.config.probe(signal), this.config.limits.timeoutMs)
      if (!ready || signal.aborted || !this.isOpen()) {return failure('dependency-unavailable')}
      return { ok: true, value: undefined }
    } catch { return failure('dependency-unavailable') } finally { controller.abort() }
  }
  respondToInteraction(ref: string, reply: InteractionReply): Promise<Reply<void>> {
    const interaction = this.interactions.get(ref)
    if (!this.isOpen() || !interaction || interaction.owner !== this.active || interaction.owner.interactionsRevoked || interaction.answering || this.control) {return Promise.resolve(failure('stale'))}
    if (reply.kind !== 'permission' || !['allow', 'deny'].includes(reply.decision)) {return Promise.resolve(failure('unsupported'))}
    interaction.answering = true
    const work = this.answer(interaction, ref, reply.decision)
    this.replies.add(work)
    void work.finally(() => { this.replies.delete(work); this.wake() }).catch(() => {})
    return work
  }
  private async answer(interaction: Interaction, ref: string, decision: 'allow' | 'deny'): Promise<Reply<void>> {
    try {
      await this.protocol.replyPermission(interaction.permission.requestId, decision, interaction.owner.interactionAbort.signal)
      this.interactions.delete(ref); this.settledInteractions.add(ref)
      if (!this.isOpen() || this.active !== interaction.owner || interaction.owner.interactionsRevoked) {return failure('stale')}
      return { ok: true, value: undefined }
    } catch (error) {
      if (interaction.owner.interactionsRevoked && executionWasNotSubmitted(error)) {return failure('stale')}
      this.seal('unknown'); return failure('unknown')
    }
  }
  interrupt(operationRef: string): Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>> {
    if (!this.isOpen() || !this.active || this.active.input.operationRef !== operationRef) {return Promise.resolve(failure('stale'))}
    if (this.active.preparing) {return Promise.resolve(failure('stale'))}
    if (this.control) {return this.control}
    const pending = this.active
    pending.interactionsRevoked = true; pending.interactionAbort.abort(); this.interactions.clear()
    const done = deferred<Reply<{ requested: true; terminal: 'unconfirmed' }>>(); this.control = done.promise
    void (async () => {
      try {
        if (!pending.turn) {throw new Error('unknown_native_handoff')}
        await pending.turn.interrupt()
        done.resolve({ ok: true, value: { requested: true, terminal: 'unconfirmed' } })
      } catch { this.seal('unknown'); done.resolve(failure('unknown')) }
      finally { this.control = undefined; this.wake() }
    })()
    return done.promise
  }
  checkpoint(): Reply<unknown> {
    if (!this.isOpen() || this.active || this.queued.length || this.control || this.replies.size || this.interactions.size) {return failure('unavailable')}
    return { ok: true, value: { version: 1, engine: this.config.engine, nativeSessionId: this.config.nativeSessionId,
      compatibility: this.config.compatibility } }
  }
  close(): Promise<CloseReceipt> {
    if (this.closing) {return this.closing}
    this.seal('unknown'); this.state = 'closed'; this.abort.abort(); this.wake()
    this.closing = (async () => {
      try {
        await bounded(Promise.all([this.loop, this.control, ...this.replies]), this.config.limits.timeoutMs)
        await bounded(this.protocol.dispose(), this.config.limits.timeoutMs)
        const stopped = await bounded(this.config.confirmStopped(), this.config.limits.timeoutMs)
        return { logicallyClosed: true as const, cleanup: stopped ? 'confirmed' as const : 'unknown' as const }
      } catch { return { logicallyClosed: true as const, cleanup: 'unknown' as const } }
      finally { this.feed.end() }
    })()
    return this.closing
  }
  private async run(): Promise<void> {
    try {
      while (this.state !== 'closed') {
        if (!this.isOpen() || this.active || this.control || this.replies.size || this.queued.length === 0) { await this.wakeup.promise; continue }
        const ready = await this.checkReadiness()
        if (!ready.ok) { this.seal(ready.code); continue }
        if (!this.isOpen() || this.hasControl()) {continue}
        const pending = this.queued.shift(); if (!pending) {continue}
        this.active = pending; this.turnEvents = 0; this.turnBytes = 0; this.settledInteractions.clear()
        try {
          const attachments = await prepareAttachments(pending.input, { trustedBinding: this.config.trustedBinding, sessionRef: this.sessionRef, port: this.config.attachments, signal: pending.interactionAbort.signal, timeoutMs: this.config.limits.timeoutMs })
          if (!this.canSubmit(pending)) { pending.done.resolve(failure('stale', true)); continue }
          if (!await this.observeBefore(pending)) { pending.done.resolve(failure('stale', true)); continue }
          pending.preparing = false
          const turn = await this.protocol.queue(pending.nativeId, pending.input.content, attachments)
          if (!this.isOpen()) { pending.done.resolve(failure('unknown')); continue }
          pending.turn = turn; pending.nativeId = turn.nativeInputId; pending.handed = true; pending.done.resolve(handoff(pending.input))
          await this.poll(pending, turn)
        } catch (error) {
          if (this.rejectAttachments(error, pending)) { continue }
          pending.capture?.gap('transport')
          if (!pending.handed && executionWasNotSubmitted(error)) {
            pending.done.resolve(failure('dependency-unavailable', true)); this.active = undefined; this.seal('dependency-unavailable')
          } else { pending.done.resolve(failure('unknown')); this.seal('unknown') }
        }
      }
    } finally { this.feed.end() }
  }
  private async observeBefore(pending: Pending): Promise<boolean> {
    if (this.config.engine === 'opencode-v1' && this.config.capture) {
      pending.preparing = true
      pending.capture = new OpenCodeInputWindowCapture({ identity: { sessionRef: this.sessionRef, windowRef: randomUUID(),
        inputId: pending.input.inputId, operationRef: pending.input.operationRef, nativeSessionId: this.config.nativeSessionId },
        port: this.config.capture, abort: this.abort.signal, timeoutMs: this.config.limits.timeoutMs,
        maxItems: this.config.limits.outputEvents, maxBytes: this.config.limits.outputBytes })
      await pending.capture.before()
    }
    return this.canSubmit(pending)
  }
  private canSubmit(pending: Pending): boolean { return this.isOpen() && this.active === pending && !pending.interactionsRevoked && !this.hasControl() }
  private rejectAttachments(error: unknown, pending: Pending): boolean {
    if (!(error instanceof AttachmentFailure) || pending.handed) { return false }
    pending.done.resolve(failure(error.code, true)); pending.interactionAbort.abort()
    if (this.active === pending) { this.active = undefined } this.wake(); return true
  }
  private async poll(pending: Pending, turn: DriverTurn): Promise<void> {
    const deadline = Date.now() + this.config.limits.timeoutMs
    while (this.isOpen() && this.active === pending) {
      if (Date.now() >= deadline) { this.seal('unknown'); return }
      const snapshot = await turn.read()
      if (!this.isOpen() || this.active !== pending) {return}
      this.knownTerminal = snapshot.terminal ? { kind: 'result', outcome: snapshot.terminal, sessionRef: this.sessionRef,
        inputId: pending.input.inputId, operationRef: pending.input.operationRef } : undefined
      for (const fact of snapshot.facts) {this.emit(fact, pending)}
      if (!this.isOpen()) {return}
      if (snapshot.terminal) {
        pending.interactionsRevoked = true; pending.interactionAbort.abort()
        await pending.capture?.after(turn.nativeInputId, snapshot.terminal, snapshot.observations ?? [])
        if (!this.isOpen() || this.active !== pending) {return}
        this.emit({ kind: 'result', outcome: snapshot.terminal }, pending)
        this.knownTerminal = undefined; this.interactions.clear(); if (this.active === pending) {this.active = undefined}
        return
      }
      if (!this.control && !pending.interactionsRevoked) {this.admitPermissions(snapshot.permissions, pending)}
      await delay(this.protocol.pollIntervalMs, undefined, { signal: this.abort.signal })
    }
  }
  private admitPermissions(permissions: readonly DriverPermission[], owner: Pending): void {
    if (!this.isOpen() || this.active !== owner || owner.interactionsRevoked || this.control) {return}
    for (const permission of permissions) {
      const ref = owner.nativeId + ':' + permission.requestId
      if (this.interactions.has(ref) || this.settledInteractions.has(ref)) {continue}
      if (this.interactions.size >= this.config.limits.pendingInteractions) { this.seal('output-limit'); return }
      this.interactions.set(ref, { permission, owner, answering: false })
      this.emit({ kind: 'interaction', interactionRef: ref, request: { kind: 'permission', tool: permission.tool, input: permission.input } }, owner)
    }
  }
  private emit(fact: EventPayload, owner: Pending): void {
    this.turnEvents++; this.turnBytes += Buffer.byteLength(JSON.stringify(fact))
    const event: Event = structuredClone({ ...fact, sessionRef: this.sessionRef, inputId: owner.input.inputId, operationRef: owner.input.operationRef })
    if (this.turnEvents > this.config.limits.outputEvents || this.turnBytes > this.config.limits.outputBytes || !this.feed.push(event)) {
      this.seal('output-limit', event.kind === 'result' ? { ...event, code: 'output-limit' } : undefined)
    }
  }
  private seal(code: FailureCode, knownTerminal?: Extract<Event, { kind: 'result' }>): void {
    if (!this.isOpen()) {return}
    this.state = 'unavailable'
    const pending = this.active; this.active = undefined
    if (pending) {
      pending.interactionsRevoked = true; pending.interactionAbort.abort()
      pending.capture?.gap(code === 'output-limit' ? 'limit' : 'transport')
      pending.done.resolve(failure(code, pending.preparing))
      this.feed.finishWith(pending.preparing ? { kind: 'diagnostic', code, sessionRef: this.sessionRef } : knownTerminal ?? (code === 'output-limit' && this.knownTerminal ? { ...this.knownTerminal, code } : undefined) ?? { kind: 'result', outcome: 'unknown', code, sessionRef: this.sessionRef,
        inputId: pending.input.inputId, operationRef: pending.input.operationRef })
    } else {this.feed.finishWith({ kind: 'diagnostic', code, sessionRef: this.sessionRef })}
    for (const item of this.queued.splice(0)) {item.done.resolve(failure(code, true))}
    this.interactions.clear(); this.wake()
  }
  private isOpen(): boolean { return this.state === 'open' }
  private hasControl(): boolean { return this.control !== undefined }
  private wake(): void { this.wakeup.resolve(); this.wakeup = deferred<void>() }
}
