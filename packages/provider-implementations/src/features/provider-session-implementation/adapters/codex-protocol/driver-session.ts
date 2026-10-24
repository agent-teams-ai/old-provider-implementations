import { randomUUID } from 'node:crypto'
import { CodexInputWindowCapture } from './input-window-capture.ts'
import type { CloseReceipt, Event, EventPayload, FailureCode, Handoff, Input, InteractionReply, Reply, Session } from '@agent-teams/provider-session-contracts'
import { bounded, deferred, EventFeed } from '../provider-session-io/io.ts'
import { CodexAppServerClient } from './app-server.ts'
import { driverCompatibility } from './driver-config.ts'
import type { CodexDriverCheckpoint, CodexDriverConfig } from './driver-config.ts'
import { CodexDriverInteractions } from './driver-interactions.ts'
import { projectDriverEvent } from './driver-output.ts'
import { CodexProtocolError } from './rpc-types.ts'
import type { CodexAppServerEvent, CodexTurnOutcome, CodexTurnRef, CodexTurnSubmission } from './session-types.ts'
import type { CodexThreadSession } from './thread-session.ts'
import { AttachmentFailure, assertSerializedAttachments, prepareAttachments, snapshotInput, validCanonicalInput, validateAttachments } from '../provider-session-io/attachments.ts'
import { exactMcpPolicyReady, requiredMcpToolsReady } from './mcp-status.ts'

const failure = (code: FailureCode, unsent = false) => ({ ok: false as const, code, ...(unsent ? { delivery: 'known-not-sent' as const } : {}) })
type Pending = { input: Input; ownerKey: string; receipt: ReturnType<typeof deferred<Reply<Handoff>>>; abort: AbortController; revoked: boolean; earlyBytes: number;
  capture?: CodexInputWindowCapture; turn?: CodexTurnSubmission; ref?: CodexTurnRef; outcome?: CodexTurnOutcome; early: CodexAppServerEvent[] }
const isKnownUnsent = (owner: Pending, error: unknown): boolean => !owner.turn || (error instanceof CodexProtocolError && error.acceptance === 'not-sent')
type Control = Reply<{ requested: true; terminal: 'unconfirmed' }>
const outcome = (native: CodexTurnOutcome): Extract<EventPayload, { kind: 'result' }> => ({ kind: 'result',
  outcome: native.outcome === 'completed' ? 'succeeded' : native.outcome === 'interrupted' ? 'cancelled' : native.outcome === 'failed' ? 'failed' : 'unknown',
  ...(native.outcome === 'failed' ? { code: 'provider-failure' as const } : {}) })

/** Volatile provider protocol state only. No process, durable input or product-state ownership. */
export class CodexDriverSession implements Session {
  readonly sessionRef: string
  private readonly config: CodexDriverConfig
  private readonly client: CodexAppServerClient
  private readonly feed: EventFeed<Event>
  private readonly interactions: CodexDriverInteractions
  private readonly queued: Pending[] = []
  private readonly nativeItemOwners = new Map<string, string | null>()
  private nativeItemBytes = 0
  private legacyItemsExhausted = false
  private readonly abort = new AbortController()
  private thread: CodexThreadSession | undefined
  private active: Pending | undefined
  private state: 'open' | 'unavailable' | 'closed' = 'open'
  private control: Promise<Control> | undefined
  private closing: Promise<CloseReceipt> | undefined
  private turnBytes = 0
  private turnEvents = 0
  constructor(config: CodexDriverConfig, restored?: CodexDriverCheckpoint) {
    this.config = config; this.sessionRef = config.binding.sessionId
    for (const [item, owner] of restored?.itemOwners ?? []) {
      this.nativeItemOwners.set(item, owner); this.nativeItemBytes += Buffer.byteLength(item) + (owner === null ? 0 : Buffer.byteLength(owner))
    }
    this.legacyItemsExhausted = restored?.legacyItemsExhausted ?? false
    this.feed = new EventFeed(config.limits.outputEvents, config.limits.outputBytes)
    this.interactions = new CodexDriverInteractions(config.limits.pendingInteractions, (event, owner) => {
      if (owner === this.active && !this.active.revoked) {this.emit(event, this.active)}
    })
    this.client = new CodexAppServerClient({ transport: config.transport,
      limits: { ...config.rpcLimits, requestTimeoutMs: Math.min(config.rpcLimits?.requestTimeoutMs ?? config.limits.timeoutMs, config.limits.timeoutMs) }, maxThreads: 1,
      maxQueuedTurns: 1, maxBufferedNotifications: 64, maxTextBytes: config.limits.outputBytes,
      onEvent: event => { this.nativeEvent(event) }, onItem: (ref, itemId) => { this.rememberNativeItem(ref, itemId) }, requestApproval: async (request, signal) => {
        const owner = this.active
        if (!owner || !this.acceptsInteraction(owner)) {throw new Error('codex.driver.stale-interaction')}
        const ref = await owner.turn?.accepted
        if (!ref || signal.aborted || !this.acceptsInteraction(owner)) {throw new Error('codex.driver.stale-interaction')}
        if (request.turnId === null && (this.legacyItemsExhausted || request.itemId === null || request.itemId.length === 0 || this.nativeItemOwners.get(request.itemId) !== owner.ownerKey)) {
          this.emit({ kind: 'diagnostic', code: this.legacyItemsExhausted ? 'output-limit' : 'unsupported' }, owner)
          throw new Error('codex.driver.ambiguous-legacy-item')
        }
        return this.interactions.request(request, signal, owner)
      } })
  }
  async open(nativeThread?: string): Promise<void> {
    await this.client.initialize(this.config.initialize)
    if (this.config.mcpPolicy && (!await bounded(this.config.verifyMcpCatalog!(this.abort.signal), this.config.limits.timeoutMs) || !await this.client.matchesMcpConfiguration(this.config.mcpPolicy, this.abort.signal))) { throw new Error('codex.driver.mcp-policy-mismatch') }
    this.thread = nativeThread === undefined ? await this.client.startThread(this.config.threadParams) : await this.client.resumeThread(nativeThread, this.config.threadParams)
  }
  submit(supplied: Input): Promise<Reply<Handoff>> {
    if (this.state !== 'open') {return Promise.resolve(failure('unavailable', true))}
    let input: Input
    try { input = snapshotInput(supplied); validateAttachments(input, 'codex', typeof this.config.threadParams.model === 'string' ? this.config.threadParams.model : undefined, this.config.attachments) }
    catch (error) { return Promise.resolve(failure(error instanceof AttachmentFailure ? error.code : 'invalid-config', true)) }
    if (!validCanonicalInput(input, this.config.limits.inputBytes))
      {return Promise.resolve(failure('invalid-config', true))}
    if (this.active?.input.inputId === input.inputId || this.active?.input.operationRef === input.operationRef
      || this.queued.some(item => item.input.inputId === input.inputId || item.input.operationRef === input.operationRef)) {return Promise.resolve(failure('stale', true))}
    if (this.queued.length >= this.config.limits.queuedInputs) {return Promise.resolve(failure('backpressure', true))}
    const pending: Pending = { input, ownerKey: randomUUID(), receipt: deferred(), abort: new AbortController(), revoked: false, early: [], earlyBytes: 0 }
    this.queued.push(pending); this.advance(); return pending.receipt.promise
  }
  observe(): AsyncIterable<Event> { return this.feed }
  async checkReadiness(): Promise<Reply<void>> {
    if (this.state !== 'open' || !this.client.isOpen()) {return failure('unavailable')}
    const deadline = new AbortController()
    try {
      const signal = AbortSignal.any([deadline.signal, this.abort.signal])
      const ready = await bounded((async () => {
        if (this.config.mcpPolicy) {
          const policy = this.config.mcpPolicy
          if (!this.thread || !await this.config.verifyMcpCatalog!(signal) || !await this.client.matchesMcpConfiguration(policy, signal) ||
            !await exactMcpPolicyReady(this.client, this.thread.threadId, { selected: Object.keys(policy.selected), disabled: policy.catalog.servers.filter(row => !Object.hasOwn(policy.selected, row.name)).map(row => row.name), required: this.config.requiredMcpTools ?? {} }, signal)) { return false }
        }
        if (!this.config.mcpPolicy && this.config.requiredMcpTools && Object.keys(this.config.requiredMcpTools).length > 0 &&
          (!this.thread || !await requiredMcpToolsReady(this.client, this.thread.threadId, this.config.requiredMcpTools, signal))) { return false }
        return this.config.probe(signal)
      })(), this.config.limits.timeoutMs)
      return ready && this.isUsable() ? { ok: true, value: undefined } : failure('dependency-unavailable')
    } catch { return failure('dependency-unavailable') } finally { deadline.abort() }
  }
  respondToInteraction(ref: string, reply: InteractionReply): Reply<void> {
    if (this.state !== 'open' || this.active?.revoked === true || this.control) {return failure('stale')}
    return this.interactions.respond(ref, reply, this.active)
  }
  interrupt(operationRef: string): Promise<Control> {
    const owner = this.active
    if (this.state !== 'open' || !owner || owner.input.operationRef !== operationRef || !owner.turn) {return Promise.resolve(failure('stale'))}
    if (this.control) {return this.control}
    owner.revoked = true
    this.control = (async (): Promise<Control> => {
      try {
        const target = await owner.turn!.accepted
        if (this.state !== 'open' || this.active !== owner || owner.outcome) {return failure('stale')}
        await this.thread!.interrupt(target)
        return { ok: true, value: { requested: true, terminal: 'unconfirmed' } }
      } catch {
        if (owner.outcome) {return failure('stale')}
        this.seal('unknown'); return failure('unknown')
      }
    })()
    void this.control.finally(() => { this.control = undefined; this.advance() })
    return this.control
  }
  checkpoint(): Reply<unknown> {
    if (this.state !== 'open' || !this.client.isOpen() || !this.thread || this.active || this.queued.length || this.control || this.interactions.size) {return failure('unavailable')}
    return { ok: true, value: { version: 2, engine: 'codex-app-server', nativeThreadId: this.thread.threadId, compatibility: driverCompatibility(this.config),
      itemOwners: [...this.nativeItemOwners], legacyItemsExhausted: this.legacyItemsExhausted } }
  }
  close(): Promise<CloseReceipt> {
    if (this.closing) {return this.closing}
    const done = deferred<CloseReceipt>(); this.closing = done.promise
    this.seal('unknown'); this.state = 'closed'; this.abort.abort(); this.client.close()
    void (async () => {
      try { done.resolve({ logicallyClosed: true, cleanup: await bounded(this.config.confirmStopped(), this.config.limits.timeoutMs) ? 'confirmed' : 'unknown' }) }
      catch { done.resolve({ logicallyClosed: true, cleanup: 'unknown' }) }
      finally { this.feed.end() }
    })()
    return this.closing
  }
  private rememberNativeItem(ref: CodexTurnRef, itemId: string): void {
    if (this.state !== 'open' || !this.active || ref.threadId !== this.thread?.threadId || (this.active.ref && ref.turnId !== this.active.ref.turnId)) {return}
    if (this.nativeItemOwners.has(itemId)) {
      const previous = this.nativeItemOwners.get(itemId)
      if (previous !== this.active.ownerKey) {
        this.nativeItemBytes -= previous === null || previous === undefined ? 0 : Buffer.byteLength(previous)
        this.nativeItemOwners.set(itemId, null)
      }
      return
    }
    const bytes = Buffer.byteLength(itemId) + Buffer.byteLength(this.active.ownerKey)
    if (this.nativeItemOwners.size >= this.config.limits.outputEvents || this.nativeItemBytes + bytes > this.config.limits.outputBytes) {
      this.legacyItemsExhausted = true; return
    }
    this.nativeItemOwners.set(itemId, this.active.ownerKey); this.nativeItemBytes += bytes
  }
  private advance(): void {
    if (this.state !== 'open' || this.active || this.control || !this.thread) {return}
    const next = this.queued.shift(); if (!next) {return}
    this.active = next; this.turnBytes = 0; this.turnEvents = 0
    void this.run(next)
  }
  private isUsable(): boolean { return this.state === 'open' && this.client.isOpen() }
  private isCurrent(owner: Pending): boolean { return this.state === 'open' && this.active === owner }
  private acceptsInteraction(owner: Pending): boolean { return this.isCurrent(owner) && !owner.revoked }
  private acceptsTurn(owner: Pending): boolean { return this.acceptsInteraction(owner) && !this.control }
  private async observeBefore(owner: Pending): Promise<boolean> {
    if (this.config.capture) {
      owner.capture = new CodexInputWindowCapture({ port: this.config.capture, abort: owner.abort.signal,
        identity: { sessionRef: this.sessionRef, windowRef: owner.ownerKey, inputId: owner.input.inputId, operationRef: owner.input.operationRef, threadId: this.thread!.threadId },
        timeoutMs: this.config.limits.timeoutMs, maxItems: this.config.limits.outputEvents, maxBytes: this.config.limits.outputBytes })
      await owner.capture.before()
    }
    return this.acceptsTurn(owner)
  }
  private async run(owner: Pending): Promise<void> {
    try {
      const ready = await this.checkReadiness()
      if (!this.isCurrent(owner)) {return}
      if (!ready.ok) { owner.receipt.resolve(failure(ready.code, true)); this.seal(ready.code, true); return }
      const attachments = await prepareAttachments(owner.input, { trustedBinding: this.config.trustedBinding, sessionRef: this.sessionRef, port: this.config.attachments, signal: owner.abort.signal, timeoutMs: this.config.limits.timeoutMs, requirePath: true })
      if (!this.acceptsTurn(owner)) { return }
      const parts = [{ type: 'text', text: owner.input.content, text_elements: [] }, ...attachments.map(item => ({ type: 'localImage', path: item.nativePath! }))]
      if (attachments.length) { assertSerializedAttachments(parts) }
      if (!await this.observeBefore(owner)) {return}
      owner.turn = this.thread!.submitTurn({ ...this.config.turnParams, input: parts }, owner.abort.signal)
      // Capture completion before any event sink can close the client on output overflow.
      void owner.turn.completed.then(result => { owner.outcome = result; return result }, () => {})
      owner.ref = await owner.turn.accepted
      if (!this.isCurrent(owner)) {return}
      owner.receipt.resolve({ ok: true, value: { inputId: owner.input.inputId, operationRef: owner.input.operationRef,
        delivery: 'client-consumed', providerAcceptance: 'unknown' } })
      for (const event of owner.early.splice(0)) {this.nativeEvent(event)}
      const terminal = await bounded(owner.turn.completed, this.config.limits.timeoutMs)
      if (!this.isCurrent(owner)) {return}
      owner.revoked = true
      await owner.capture?.after(terminal)
      if (!this.isCurrent(owner)) {return}
      this.emit(outcome(terminal), owner); owner.abort.abort()
      if (!this.isCurrent(owner)) {return}
      this.active = undefined
      if (terminal.outcome === 'unknown') {this.seal('unknown')}
      else {this.advance()}
    } catch (error) {
      if (error instanceof AttachmentFailure && !owner.turn) {
        owner.receipt.resolve(failure(error.code, true)); owner.abort.abort();
        if (this.isCurrent(owner)) { this.active = undefined; this.advance() } return
      }
      const unsent = isKnownUnsent(owner, error)
      owner.receipt.resolve(failure(unsent ? 'dependency-unavailable' : 'unknown', unsent))
      this.seal(unsent ? 'dependency-unavailable' : 'unknown', unsent)
    }
  }
  private nativeEvent(event: CodexAppServerEvent): void {
    const owner = this.active
    if (!owner || this.state !== 'open' || event.threadId !== this.thread?.threadId) {return}
    if (projectDriverEvent(event.event).length === 0) {return}
    if (!owner.ref) {
      owner.earlyBytes += Buffer.byteLength(JSON.stringify(event))
      if (owner.early.length >= this.config.limits.outputEvents || owner.earlyBytes > this.config.limits.outputBytes) { this.seal('output-limit'); return }
      owner.early.push(event); return
    }
    if (event.turnId !== owner.ref.turnId) {return}
    owner.capture?.record(event)
    for (const fact of projectDriverEvent(event.event)) {this.emit(fact, owner)}
  }
  private emit(fact: EventPayload, owner: Pending): void {
    if (this.state !== 'open' || this.active !== owner) {return}
    this.turnEvents++; this.turnBytes += Buffer.byteLength(JSON.stringify(fact))
    const event: Event = structuredClone({ ...fact, sessionRef: this.sessionRef, inputId: owner.input.inputId, operationRef: owner.input.operationRef })
    if (this.turnEvents > this.config.limits.outputEvents || this.turnBytes > this.config.limits.outputBytes || !this.feed.push(event)) {this.seal('output-limit')}
  }
  private seal(code: FailureCode, unsent = false): void {
    if (this.state !== 'open') {return}
    this.state = 'unavailable'; this.abort.abort()
    const owner = this.active; this.active = undefined
    const knownUnsent = unsent || !!(owner && !owner.turn)
    if (owner) { owner.revoked = true; owner.abort.abort(); owner.receipt.resolve(failure(code, knownUnsent)) }
    for (const queued of this.queued.splice(0)) {queued.receipt.resolve(failure(code, true))}
    this.client.close()
    // The native client commits terminal before projecting its final output. Preserve that observed fact.
    owner?.capture?.gap(code === 'output-limit' ? 'limit' : 'transport')
    queueMicrotask(() => {
      const terminal: EventPayload = owner?.outcome ? { ...outcome(owner.outcome), ...(code === 'output-limit' ? { code } : {}) } : { kind: 'result', outcome: 'unknown', code }
      if (owner && !knownUnsent) {this.feed.finishWith({ ...terminal, sessionRef: this.sessionRef, inputId: owner.input.inputId, operationRef: owner.input.operationRef })}
      else {this.feed.finishWith({ kind: 'diagnostic', code, sessionRef: this.sessionRef })}
    })
  }
}
