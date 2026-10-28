import { randomUUID } from 'node:crypto';
import type { CanUseTool, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CloseReceipt, Event, EventPayload, FailureCode, Handoff, Input, InteractionReply, Reply, Session } from '@agent-teams/provider-session-contracts';
import { compatibility, options, SDK_REVISION } from './config.ts';
import type { ClaudeConfig } from './config.ts';
import { toolBindingHook } from './tool-binding.ts';
import type { ForegroundToolOwner } from './tool-binding.ts';
import { ClaudeSubagents } from './subagents.ts';
import { ClaudeCapture } from './capture.ts';
import { Interactions } from './interactions.ts';
import { Normalizer, OutputLimitError, record } from './normalize.ts';
import { bounded, deferred, EventFeed } from '../provider-session-io/io.ts';
import { fail } from './primitives.ts';
import { AttachmentFailure, assertSerializedAttachments, prepareAttachments, snapshotInput, validateAttachments } from '../provider-session-io/attachments.ts';
import type { PreparedAttachment } from '../provider-session-io/attachments.ts';
export type QueryHandle = Pick<Query, 'interrupt' | 'close' | 'mcpServerStatus'> & Partial<Pick<Query, 'stopTask'>> & AsyncIterable<unknown>;
export type QueryFactory = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle;
type PendingInput = { input: Input; handed: boolean; nativeRef: ReturnType<typeof randomUUID>; receipt: ReturnType<typeof deferred<Reply<Handoff>>>; interactionsCancelled: boolean; toolRevocation: AbortController };
/** A complete successful main-thread result without foreground or restore provenance. */
function idleNativeSuccess(m: Record<string, unknown>, nativeSession: string): boolean {
  const numbers = [m.duration_ms, m.duration_api_ms, m.total_cost_usd];
  const objects = [m.usage, m.modelUsage];
  return m.type === 'result' && m.subtype === 'success' && m.is_error === false && m.session_id === nativeSession &&
    (m.parent_tool_use_id === null || m.parent_tool_use_id === undefined) &&
    [m.agent_id, m.resume_reason, m.user_message_uuid, m.user_message_uuids].every(value => value === undefined) &&
    typeof m.uuid === 'string' && m.uuid.length > 0 && typeof m.result === 'string' &&
    (m.stop_reason === null || typeof m.stop_reason === 'string') &&
    typeof m.num_turns === 'number' && Number.isSafeInteger(m.num_turns) && m.num_turns >= 0 &&
    numbers.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) &&
    objects.every(value => value !== null && typeof value === 'object' && !Array.isArray(value)) &&
    Array.isArray(m.permission_denials);
}
export class ClaudeSession implements Session {
  readonly sessionRef: string;
  private state: 'open' | 'unavailable' | 'closed' = 'open';
  private readonly feed: EventFeed<Event>;
  private readonly normalizer: Normalizer;
  private readonly backgroundNormalizer: Normalizer;
  private readonly interactions: Interactions;
  private readonly query: QueryHandle;
  private readonly readLoop: Promise<void>;
  private readonly queued: PendingInput[] = [];
  private active: PendingInput | undefined;
  private readonly messageOwners = new Map<string, Input>();
  private readonly toolOwners = new Map<string, { input: Input; name: string }>();
  private toolOwnershipChanged = deferred<void>();
  private pendingToolOwners = 0;
  private readonly nativeToolIdentities = new Map<string, { nativeInput: string; name: string }>();
  private streamRef: string | undefined;
  private foregroundBound = false;
  private turnBytes = 0;
  private turnEvents = 0;
  private knownTerminal: Extract<Event, { kind: 'result' }> | undefined;
  private wakeup = deferred<void>();
  private readonly inputClosed = deferred<void>();
  private control: Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>> | undefined;
  private closing?: Promise<CloseReceipt>;
  private readiness: Promise<Reply<void>> | undefined;
  private failure: FailureCode | undefined;
  private readonly config: ClaudeConfig;
  private readonly nativeSession: string;
  private readonly subagents: ClaudeSubagents | undefined;
  private readonly capture: ClaudeCapture | undefined;
  constructor(config: ClaudeConfig, nativeSession: string, restore: boolean, factory: QueryFactory) {
    this.config = config; this.nativeSession = nativeSession;
    this.sessionRef = config.sessionRef;
    this.feed = new EventFeed(config.limits.outputEvents, config.limits.outputBytes);
    this.normalizer = new Normalizer(config.limits.outputBytes);
    this.backgroundNormalizer = new Normalizer(config.limits.outputBytes);
    this.interactions = new Interactions(config.limits.pendingInteractions, config.limits.timeoutMs, (event, childRef, toolRef): void | Promise<void> => {
      if (!this.active || this.active.interactionsCancelled || this.state !== 'open') { this.interactions.cancel(); return; }
      if (childRef !== undefined) {return this.childInteraction(event, childRef, toolRef);}
      this.emit(event, this.active.input);
    });
    const currentToolOwner = (toolId: string, toolName: string) => {
      const active = this.active; const owner = this.toolOwners.get(toolId);
      if (active === undefined || !owner || owner.name !== toolName || owner.input !== active.input) { return; }
      return this.state === 'open' && !active.interactionsCancelled ? { ...active.input, nativeRef: active.nativeRef, revoked: active.toolRevocation.signal } : undefined;
    };
    const preToolUse = config.toolBinding ? toolBindingHook(config.toolBinding, this.sessionRef, nativeSession, currentToolOwner, config.limits.timeoutMs) : undefined;
    this.capture = config.capture ? new ClaudeCapture({ port: config.capture, sessionRef: this.sessionRef, nativeSession,
      names: config.nativeTools, currentOwner: currentToolOwner, maxPairs: config.limits.outputEvents,
      maxBytes: config.limits.outputBytes, timeoutMs: config.limits.timeoutMs }) : undefined;
    this.subagents = config.subagents ? new ClaudeSubagents({ port: config.subagents, sessionRef: this.sessionRef, nativeSession, currentOwner: currentToolOwner,
      awaitOwner: (id, name, signal) => this.awaitToolOwner(id, name, signal, currentToolOwner),
      maxEvents: config.limits.outputEvents, maxBytes: config.limits.outputBytes, timeoutMs: config.limits.timeoutMs }) : undefined;
    const beforeHooks = [...(this.subagents ? [this.subagents.hook] : []), ...(preToolUse ? [preToolUse] : []), ...(this.capture ? [this.capture.hook] : [])];
    this.query = factory({ prompt: this.inputs(), options: { ...options(config, nativeSession, restore), canUseTool: this.requestInteraction,
      ...(beforeHooks.length ? { hooks: { PreToolUse: [{ hooks: beforeHooks }],
        ...(this.capture ? { PostToolUse: [{ hooks: [this.capture.hook] }], PostToolUseFailure: [{ hooks: [this.capture.hook] }],
          ...(this.capture.completesBatches ? { PostToolBatch: [{ hooks: [this.capture.batchHook] }] } : {}) } : {}) } } : {}) } });
    this.readLoop = this.read();
  }
  submit(input: Input): Promise<Reply<Handoff>> {
    if (this.state !== 'open') {return Promise.resolve(fail(this.failure ?? 'unavailable'));}
    if (!input.inputId || !input.operationRef || !input.content || Buffer.byteLength(input.content) > this.config.limits.inputBytes) {return Promise.resolve(fail('backpressure'));}
    try { input = snapshotInput(input); validateAttachments(input, 'claude', this.config.model, this.config.attachments); }
    catch (error) { return Promise.resolve({ ok: false, code: error instanceof AttachmentFailure ? error.code : 'invalid-config', delivery: 'known-not-sent' }); }
    if ((this.active?.input.operationRef === input.operationRef || this.active?.input.inputId === input.inputId) || this.queued.some((v) => v.input.operationRef === input.operationRef || v.input.inputId === input.inputId)) {return Promise.resolve(fail('stale'));}
    if (this.queued.length >= this.config.limits.queuedInputs) {return Promise.resolve(fail('backpressure'));}
    const pending: PendingInput = { input, handed: false, nativeRef: randomUUID(), receipt: deferred<Reply<Handoff>>(), interactionsCancelled: false, toolRevocation: new AbortController() };
    this.queued.push(pending); this.wake(); return pending.receipt.promise;
  }
  observe(): AsyncIterable<Event> { return this.feed; }
  respondToInteraction(ref: string, reply: InteractionReply): Reply<void> {
    if (this.active?.interactionsCancelled === true) { return fail('stale'); }
    return this.state === 'open' ? this.interactions.reply(ref, reply) : fail('unavailable');
  }
  private readonly requestInteraction: CanUseTool = (...args) => {
    if ((args[2].agentID === undefined && this.subagents?.ownsTool(args[2].toolUseID) === true) ||
        (args[2].agentID !== undefined && this.subagents?.canInteract(args[2].agentID, args[2].toolUseID, args[0]) !== true)) {
      return Promise.resolve({ behavior: 'deny', message: 'Child interaction provenance unavailable' });
    }
    if (this.state !== 'open' || !this.active || this.active.interactionsCancelled) {
      return Promise.resolve({ behavior: 'deny', message: 'Interaction unavailable for this operation' });
    }
    return this.interactions.request(...args);
  };
  private async childInteraction(event: EventPayload, childRef: string, toolRef: string | undefined): Promise<void> {
    const active = this.active;
    if (!active || !this.subagents || (toolRef === undefined || toolRef.length === 0) || event.kind !== 'interaction') {throw new Error('Child interaction unavailable');}
    await this.subagents.interaction(childRef, toolRef, event);
    if (this.active !== active || active.interactionsCancelled || this.state !== 'open') {throw new Error('Child interaction stale');}
    this.emit(event, active.input);
  }
  checkReadiness(): Promise<Reply<void>> {
    if (this.state === 'closed' || (this.failure && this.failure !== 'dependency-unavailable')) {return Promise.resolve(fail(this.failure ?? 'unavailable'));}
    if (!this.readiness) {this.readiness = this.probe().finally(() => { this.readiness = undefined; });}
    return this.readiness;
  }
  private async probe(): Promise<Reply<void>> {
    if (this.subagents && !this.query.stopTask) {return fail('unsupported');}
    const abort = new AbortController();
    try {
      const healthy = await bounded((async () => {
        // Observe initial pending connections within the owner deadline. This does not reconnect.
        while (!abort.signal.aborted) {
          const statuses = await this.query.mcpServerStatus();
          let pending = false;
          for (const [server, required] of Object.entries(this.config.requiredTools)) {
            const status = statuses.find((item) => item.name === server);
            if (!status || status.status === 'pending') { pending = true; continue; }
            if (status.status !== 'connected' || !required.every((tool) => status.tools?.some((item) => item.name === tool) === true)) { return false; }
          }
          if (!pending) { return this.config.probe(abort.signal); }
          await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
        }
        return false;
      })(), this.config.limits.timeoutMs);
      if (!healthy || this.state === 'closed') {
        if (this.state !== 'closed') { this.unavailable('dependency-unavailable'); }
        return fail('dependency-unavailable');
      }
      if (this.failure === 'dependency-unavailable') { this.failure = undefined; this.state = 'open'; this.wake(); }
      return { ok: true, value: undefined };
    } catch { this.unavailable('dependency-unavailable'); return fail('dependency-unavailable'); }
    finally { abort.abort(); }
  }
  interrupt(operationRef: string): Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>> {
    if (this.state !== 'open') {return Promise.resolve(fail('unavailable'));}
    if (!this.active || this.active.input.operationRef !== operationRef) {return Promise.resolve(fail('stale'));}
    if (!this.active.handed) {return Promise.resolve(fail('stale'));}
    if (this.control) {return this.control;}
    // Install the fence synchronously. A result cannot release the next handoff until this settles.
    const done = deferred<Reply<{ requested: true; terminal: 'unconfirmed' }>>(); this.control = done.promise;
    this.active.interactionsCancelled = true; this.active.toolRevocation.abort();
    this.interactions.cancel();
    void this.sendInterrupt(done);
    return done.promise;
  }
  private async sendInterrupt(done: ReturnType<typeof deferred<Reply<{ requested: true; terminal: 'unconfirmed' }>>>): Promise<void> {
    try {
      await bounded(this.query.interrupt(), this.config.limits.timeoutMs);
      done.resolve({ ok: true, value: { requested: true, terminal: 'unconfirmed' } });
      this.control = undefined; this.wake();
    } catch { this.unavailable('unknown'); done.resolve(fail('unknown')); }
  }
  checkpoint(): Reply<unknown> {
    if (this.active || this.queued.length || this.control || this.failure) {return fail('unavailable');}
    return { ok: true, value: { version: 1, engine: SDK_REVISION, nativeSession: this.nativeSession, compatibility: compatibility(this.config) } };
  }
  close(): Promise<CloseReceipt> {
    if (this.closing) {return this.closing;}
    // Seal before the first await, including interaction and iterable admission.
    this.unavailable('unknown'); this.state = 'closed'; this.interactions.close(); this.rejectQueued('unavailable'); this.wake();
    this.closing = Promise.resolve().then(() => this.shutdown()); return this.closing;
  }
  private async shutdown(): Promise<CloseReceipt> {
    if (this.subagents) {
      try { await bounded(this.subagents.stopOwned(id => this.query.stopTask!(id)), this.config.limits.timeoutMs); } catch { /* Physical custody still must close independently. */ }
    }
    const captured = this.capture?.close();
    let stopped = false;
    try {
      // Keep SDK stdin and iterator teardown behind the original captured owner's stop.
      stopped = await bounded(this.config.custody.confirmStopped(), this.config.limits.timeoutMs);
      this.observeClose({ stage: 'custody', outcome: stopped ? 'confirmed' : 'unconfirmed' });
    } catch { this.observeClose({ stage: 'custody', outcome: 'error' }); }
    finally {
      this.inputClosed.resolve();
      let sdkClosed = false;
      try {
        this.query.close(); sdkClosed = true;
        this.observeClose({ stage: 'sdk-close', outcome: 'completed' });
        await bounded(this.readLoop, this.config.limits.timeoutMs);
        this.observeClose({ stage: 'sdk-read', outcome: 'completed' });
      } catch {
        stopped = false;
        this.observeClose({ stage: sdkClosed ? 'sdk-read' : 'sdk-close', outcome: 'error' });
      }
      try {
        await captured;
        if (this.capture) { this.observeClose({ stage: 'capture-close', outcome: 'completed' }); }
      } catch { stopped = false; this.observeClose({ stage: 'capture-close', outcome: 'error' }); }
      this.feed.end();
    }
    return { logicallyClosed: true, cleanup: stopped ? 'confirmed' : 'unknown' };
  }
  private observeClose(observation: Parameters<NonNullable<ClaudeConfig['observeClose']>>[0]): void {
    // Observation failures/rejections cannot change teardown order, budgets or the cached receipt.
    try { void Promise.resolve(this.config.observeClose?.(Object.freeze(observation))).catch(() => {}); }
    catch { /* Private operational observations are best effort. */ }
  }
  private async *inputs(): AsyncGenerator<SDKUserMessage> {
    while (this.state !== 'closed') {
      if (this.state !== 'open' || this.active || this.control || !this.queued.length) { await this.wakeup.promise; continue; }
      const ready = await this.checkReadiness();
      if (!ready.ok) { this.unavailable(ready.code); continue; }
      if (!this.handoffAvailable()) {continue;}
      const pending = this.queued.shift();
      if (!pending) {continue;}
      this.active = pending; this.foregroundBound = false; this.messageOwners.clear(); this.toolOwners.clear(); this.streamRef = undefined; this.turnBytes = 0; this.turnEvents = 0; this.normalizer.reset(); this.backgroundNormalizer.reset();
      let content: SDKUserMessage['message']['content'] = pending.input.content;
      if ((pending.input.attachments?.length ?? 0) > 0) {
        try {
          const attachments = await prepareAttachments(pending.input, { trustedBinding: this.config.trustedBinding, sessionRef: this.sessionRef, port: this.config.attachments, signal: pending.toolRevocation.signal, timeoutMs: this.config.limits.timeoutMs });
          content = claudeContent(pending.input.content, attachments);
          if (!this.currentInput(pending)) { throw new AttachmentFailure('stale'); }
        } catch (error) {
          pending.toolRevocation.abort(); pending.receipt.resolve({ ok: false, code: error instanceof AttachmentFailure ? error.code : 'unavailable', delivery: 'known-not-sent' });
          if (this.active === pending) { this.active = undefined; } this.wake(); continue;
        }
      }
      pending.handed = true;
      pending.receipt.resolve({ ok: true, value: { inputId: pending.input.inputId, operationRef: pending.input.operationRef, delivery: 'client-consumed', providerAcceptance: 'unknown' } });
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.nativeSession, uuid: pending.nativeRef };
    }
    // Closed admission is synchronous; EOF must still wait for caller-owned physical cleanup.
    await this.inputClosed.promise;
  }
  private currentInput(pending: PendingInput): boolean {
    return this.active === pending && this.state === 'open' && !pending.interactionsCancelled && this.control === undefined;
  }
  private handoffAvailable(): boolean {
    // This check follows an await; TypeScript's earlier narrowing is not a lifecycle fence.
    return this.state === 'open' && this.control === undefined && this.active === undefined;
  }
  private async read(): Promise<void> {
    try {
      // A for-await break invokes Query.return(), which can retire the SDK root before its owner.
      const iterator = this.query[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done === true || this.state === 'closed') {break;}
        await this.accept(next.value);
      }
      if (this.state !== 'closed') { this.emit({ kind: 'diagnostic', code: 'iterator-ended' }); this.unavailable('unknown'); }
    } catch (error) { if (this.state !== 'closed') {
      const code = error instanceof OutputLimitError ? 'output-limit' : 'provider-failure';
      this.emit({ kind: 'diagnostic', code }); this.unavailable(code);
    } }
    finally { this.feed.end(); }
  }
  private async accept(message: unknown): Promise<void> {
    const m = record(message);
    if (Boolean(m.session_id) && m.session_id !== this.nativeSession) { this.unavailable('unknown'); return; }
    if (await this.capture?.acceptTask(m) === true) {return;}
    if (await this.acceptNested(m)) {return;}
    const input = this.correlate(m);
    if (m.type === 'system' && m.subtype === 'compact_boundary') {
      if (!this.mainCompaction(m)) { return; }
      // One session-lifetime dedup owner, independent of foreground/background attribution.
      for (const fact of this.normalizer.normalize(message).facts) { this.emit(fact, input); }
      return;
    }
    if (input && !this.ownPartialTool(m, input)) { return; }
    const { facts, terminal, failure } = (input ? this.normalizer : this.backgroundNormalizer).normalize(message);
    this.knownTerminal = terminal && input ? { sessionRef: this.sessionRef, inputId: input.inputId, operationRef: input.operationRef, kind: 'result', outcome: terminal, ...(failure ? { code: failure } : {}) } : undefined;
    for (const fact of facts) {
      if (input && fact.kind === 'tool') { if (!this.ownTool(fact.toolRef, fact.name, input)) { return; } }
      this.emit(fact, input);
    }
    return this.finishAcceptance(m, terminal, failure, input);
  }
  private mainCompaction(message: Record<string, unknown>): boolean {
    return message.session_id === this.nativeSession && !present(message.parent_tool_use_id) && !present(message.agent_id) && !present(message.resume_reason);
  }
  private async acceptNested(message: Record<string, unknown>): Promise<boolean> {
    if (this.subagents && await this.subagents.accept(message)) {return true;}
    if ((message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) || message.agent_id !== undefined) {
      this.emit({ kind: 'diagnostic', code: 'unknown-event' }); return true;
    }
    return false;
  }
  private finishAcceptance(m: Record<string, unknown>, terminal: 'succeeded' | 'failed' | 'unknown' | undefined,
    failure: FailureCode | undefined, input: Input | undefined): void | Promise<void> {
    // An idle native acknowledgment is observational, never a foreground completion.
    if (this.active === undefined && input === undefined && idleNativeSuccess(m, this.nativeSession)) {
      this.emit({ kind: 'diagnostic', code: 'unknown-event' });
      return;
    }
    const settle = (recheckOwner = false) => {
      if (recheckOwner && this.active?.input !== input) {this.knownTerminal = undefined; return;}
      this.acceptTerminal(terminal, failure, input);
      this.knownTerminal = undefined; this.acceptInitialization(m);
    };
    if (terminal && input && this.capture && (this.capture.completesBatches || this.capture.retainsBackground)) {
      // Cancellation/unavailability can retire the owner during the awaited observer.
      return this.capture.finishInput(input, terminal).then(settle.bind(undefined, true));
    }
    settle();
  }
  private ownPartialTool(m: Record<string, unknown>, input: Input): boolean {
    if (m.type !== 'stream_event') { return true; }
    const event = record(m.event); const block = record(event.content_block);
    return event.type !== 'content_block_start' || block.type !== 'tool_use' ||
      typeof block.id !== 'string' || typeof block.name !== 'string' || this.ownTool(block.id, block.name, input);
  }
  private acceptTerminal(terminal: 'succeeded' | 'failed' | 'unknown' | undefined,
    failure: FailureCode | undefined, input: Input | undefined): void {
    if (terminal === undefined) { return; }
    const active = this.active;
    if (input && active !== undefined && (active.input.operationRef === input.operationRef || active.input.inputId === input.inputId)) {
      this.emit({ kind: 'result', outcome: terminal, ...(failure ? { code: failure } : {}) }, input);
      active.toolRevocation.abort(); this.active = undefined; this.interactions.cancel(); this.wake();
      if (terminal === 'unknown') {this.unavailable(failure ?? 'unknown');}
    } else { this.emit({ kind: 'result', outcome: 'unknown', code: 'unknown' }); this.unavailable('unknown'); }
  }
  private acceptInitialization(m: Record<string, unknown>): void {
    if (m.type !== 'system' || m.subtype !== 'init') { return; }
    if (m.permissionMode !== (this.config.nativeOptions?.permissionMode ?? 'default')) {this.unavailable('unsupported');}
    if (Array.isArray(m.mcp_servers) && m.mcp_servers.some((s) => { const server = record(s); return Object.hasOwn(this.config.requiredTools, String(server.name)) && !['connected', 'pending'].includes(String(server.status)); })) {this.unavailable('dependency-unavailable');}
  }
  private correlate(m: Record<string, unknown>): Input | undefined {
    const active = this.active;
    if (active === undefined || Boolean(m.parent_tool_use_id) || Boolean(m.agent_id) || Boolean(m.resume_reason)) { return undefined; }
    const echoed = m.user_message_uuid === active.nativeRef || (Array.isArray(m.user_message_uuids) && m.user_message_uuids.includes(active.nativeRef));
    if (this.foreignEcho(m, echoed)) { return undefined; }
    const nested = record(m.message); const partial = record(record(m.event).message);
    const id = typeof nested.id === 'string' ? nested.id : typeof partial.id === 'string' ? partial.id : undefined;
    this.bindMessage(m, id, echoed, active.input);
    if (echoed) { return active.input; }
    if (id !== undefined && id.length > 0) { return this.messageOwners.get(id); }
    if (m.type === 'stream_event' && m.parent_tool_use_id === null && this.streamRef !== undefined && this.streamRef.length > 0) { return this.messageOwners.get(this.streamRef); }
    return m.type === 'user' ? this.toolResultOwner(nested.content) : undefined;
  }
  private foreignEcho(m: Record<string, unknown>, echoed: boolean): boolean {
    if (echoed || (typeof m.user_message_uuid !== 'string' && !Array.isArray(m.user_message_uuids))) { return false; }
    if (m.type === 'stream_event' && m.parent_tool_use_id === null && record(m.event).type === 'message_start') { this.streamRef = undefined; }
    return true;
  }
  private bindMessage(m: Record<string, unknown>, id: string | undefined, echoed: boolean, input: Input): void {
    const foregroundFrame = m.type === 'assistant' || m.type === 'stream_event';
    if (echoed && foregroundFrame) { this.foregroundBound = true; }
    // SDK 0.3.305 echoes only the first frame of a foreground turn. Explicit
    // main-thread frames in later tool rounds retain that established binding.
    if (id !== undefined && id.length > 0 && (echoed || (this.foregroundBound && foregroundFrame && m.parent_tool_use_id === null))) {
      this.messageOwners.set(id, input);
      if (m.type === 'stream_event') { this.streamRef = id; }
    }
  }
  private ownTool(id: string, name: string, input: Input): boolean {
    const nativeInput = this.active?.input === input ? this.active.nativeRef : undefined;
    const prior = this.nativeToolIdentities.get(id);
    if (nativeInput === undefined || nativeInput.length === 0 || (prior && (prior.nativeInput !== nativeInput || prior.name !== name))) { this.unavailable('unknown'); return false; }
    // IDs have no proved global uniqueness contract. Retain bounded tombstones across turns.
    if (!prior && this.nativeToolIdentities.size >= this.config.limits.outputEvents) { this.unavailable('output-limit'); return false; }
    this.nativeToolIdentities.set(id, { nativeInput, name });
    this.toolOwners.set(id, { input, name });
    this.toolOwnershipChanged.resolve(); this.toolOwnershipChanged = deferred<void>(); return true;
  }
  /** SDK control callbacks race its independent output iterator; await an exact observed tool, never infer its owner. */
  private async awaitToolOwner(id: string, name: string, signal: AbortSignal,
    current: (id: string, name: string) => ForegroundToolOwner | undefined): Promise<ForegroundToolOwner | undefined> {
    const active = this.active;
    if (!active || this.pendingToolOwners >= this.config.limits.outputEvents) {return;}
    this.pendingToolOwners++;
    const scope = AbortSignal.any([signal, active.toolRevocation.signal, AbortSignal.timeout(this.config.limits.timeoutMs)]);
    let abort!: () => void;
    const ended = new Promise<void>(resolve => { abort = resolve; scope.addEventListener('abort', abort, { once: true }); if (scope.aborted) {abort();} });
    try {
      while (!scope.aborted && this.state === 'open' && this.active === active) {
        const owner = current(id, name);
        if (owner) {return owner;}
        await Promise.race([this.toolOwnershipChanged.promise, ended]);
      }
      return undefined;
    } finally { scope.removeEventListener('abort', abort); this.pendingToolOwners--; }
  }
  private toolResultOwner(content: unknown): Input | undefined {
    if (!this.active || !Array.isArray(content)) { return undefined; }
    const owners = content.filter((block) => record(block).type === 'tool_result').map((block) => this.toolOwners.get(String(record(block).tool_use_id))?.input);
    return owners.length && owners.every((owner) => owner?.operationRef === this.active?.input.operationRef) ? this.active.input : undefined;
  }
  private emit(fact: EventPayload, input?: Input): void {
    this.turnBytes += Buffer.byteLength(JSON.stringify(fact)); this.turnEvents += 1;
    if (this.turnBytes > this.config.limits.outputBytes || this.turnEvents > this.config.limits.outputEvents) { this.unavailable('output-limit'); return; }
    if (!this.feed.push(structuredClone({ ...fact, sessionRef: this.sessionRef, ...(input ? { inputId: input.inputId, operationRef: input.operationRef } : {}) }))) {this.unavailable('output-limit');}
  }
  private unavailable(code: FailureCode): void {
    if (this.state === 'closed' || this.failure === 'output-limit') {return;}
    this.state = 'unavailable';
    // A disappeared dependency during an accepted turn does not prove the turn stopped.
    this.failure = this.active && code === 'dependency-unavailable' ? 'unknown' : code;
    // Idle readiness may recover; retire old leases without disabling future original pairs.
    if (this.capture?.retainsBackground === true) {
      void (this.failure === 'dependency-unavailable' ? this.capture.revoke() : this.capture.close());
    }
    if (this.active) {
      this.active.toolRevocation.abort();
      if (!this.active.handed) { this.active.receipt.resolve({ ok: false, code, delivery: 'known-not-sent' }); this.active = undefined; }
    }
    if (this.active) {
      // Exactly one unknown outcome for an accepted input; never auto-replay.
      const event: Event = { sessionRef: this.sessionRef, inputId: this.active.input.inputId, operationRef: this.active.input.operationRef, kind: 'result', outcome: 'unknown', code };
      if (code === 'output-limit') {this.feed.finishWith(this.knownTerminal ? { ...this.knownTerminal, code: 'output-limit' } : event);} else {this.feed.push(event);}
      this.active = undefined;
    }
    if (code === 'output-limit') {
      this.feed.finishWith({ sessionRef: this.sessionRef, kind: 'diagnostic', code });
      void this.close();
    }
    this.interactions.cancel(); this.rejectQueued(code); this.wake();
  }
  private rejectQueued(code: FailureCode): void { for (const pending of this.queued.splice(0)) {pending.receipt.resolve(fail(code));} }
  private wake(): void { this.wakeup.resolve(); this.wakeup = deferred<void>(); }
}

function present(value: unknown): boolean { return Boolean(value); }
function claudeContent(text: string, attachments: readonly PreparedAttachment[]): SDKUserMessage['message']['content'] {
  const blocks: Exclude<SDKUserMessage['message']['content'], string> = [];
  for (const { reference, bytes } of attachments) {
    if (reference.mimeType.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: reference.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: Buffer.from(bytes).toString('base64') } });
    } else if (reference.mimeType === 'application/pdf') {
      blocks.push({ type: 'document', title: reference.artifactId, source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } });
    } else {
      let data: string;
      try { data = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new AttachmentFailure('invalid-config'); }
      blocks.push({ type: 'document', title: reference.artifactId, source: { type: 'text', media_type: 'text/plain', data } });
    }
  }
  blocks.push({ type: 'text', text }); assertSerializedAttachments(blocks); return blocks;
}
