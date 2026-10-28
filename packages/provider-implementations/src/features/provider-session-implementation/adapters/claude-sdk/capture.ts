import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'node:crypto';
import type { ForegroundToolOwner } from './tool-binding.ts';

export type ClaudeCaptureValue = null | boolean | number | string | readonly ClaudeCaptureValue[] | { readonly [key: string]: ClaudeCaptureValue };
type ToolIdentity = Readonly<{ sessionRef: string; toolUseId: string; toolName: string }>;
type BoundTool = ToolIdentity & Readonly<{ inputId: string; operationRef: string }>;
export type ClaudeCaptureRequest =
  | (BoundTool & Readonly<{ phase: 'before'; toolInput: ClaudeCaptureValue; signal: AbortSignal }>)
  // Native hook outcome only; neither eventual background completion nor user-hook ordering is implied.
  | (BoundTool & Readonly<{ phase: 'after'; toolInput: ClaudeCaptureValue; outcome: 'succeeded' | 'failed'; signal: AbortSignal }>)
  | (ToolIdentity & Readonly<{ phase: 'gap'; inputId?: string; operationRef?: string;
      reason: 'unattributed' | 'stale' | 'capture-failed' | 'oversized' | 'limit' | 'closed' | 'conflict' | 'background' | 'missing-batch' | 'batch-unqualified'; signal: AbortSignal }>);
/** Only the native mapped post-tool-use boundary; not background or sibling PostToolBatch hook finality. */
export type ClaudeCaptureBatchRequest = Readonly<{ sessionRef: string; inputId: string; operationRef: string;
  boundary: 'post-tool-use-hooks'; tools: readonly Readonly<{ toolUseId: string; toolName: string;
    toolInput: ClaudeCaptureValue; outcome: 'succeeded' | 'failed' }>[]; signal: AbortSignal }>;
type BackgroundRequest = BoundTool & Readonly<{ taskRef: string; runRef?: string; toolInput: ClaudeCaptureValue; signal: AbortSignal }> &
  (Readonly<{ phase: 'registered'; boundary: 'native-background-registration' }> |
    Readonly<{ phase: 'terminal'; boundary: 'native-task-notification'; status: 'completed' | 'failed' | 'stopped' }>);
/** Private observations. The consumer owns bytes, task attribution, persistence and abort fences on late work. */
export type ClaudeCapturePort = Readonly<{ observe: (request: ClaudeCaptureRequest) => Promise<void>;
  /** Optional awaited foreground batch observation. Other configured batch hooks remain unqualified. */
  observeBatch?: (request: ClaudeCaptureBatchRequest) => Promise<void>;
  /** Same-execution observations only; native task termination is not file authorship or descendant quiescence. */
  observeBackground?: (request: BackgroundRequest) => Promise<void> }>;

type ToolHook = Extract<HookInput, { hook_event_name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' }>;
type BatchCall = Extract<HookInput, { hook_event_name: 'PostToolBatch' }>['tool_calls'][number];
type Pair = { identity: BoundTool; owner: ForegroundToolOwner; input?: ClaudeCaptureValue; fingerprint: string;
  bytes: number; abort: AbortController; phase: 'preparing' | 'prepared' | 'finishing' | 'finished' | 'completing' | 'background' | 'background-completing' | 'completed' | 'gap'; before?: Promise<void>;
  outcome?: 'succeeded' | 'failed'; gapSent?: boolean; batch?: string; settlement?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>; detach?: () => void;
  background?: { taskRef: string; runRef?: string; registered: boolean; retained: boolean;
    terminal?: 'completed' | 'failed' | 'stopped'; registration?: Promise<void>; completion?: Promise<void> } };
type CaptureOptions = {
  port: ClaudeCapturePort; sessionRef: string; nativeSession: string; names: readonly string[];
  currentOwner(toolUseId: string, toolName: string): ForegroundToolOwner | undefined;
  maxPairs: number; maxBytes: number; timeoutMs: number;
};

/** Session-local bounded native pairs. Capture never grants, denies or changes a tool input. */
export class ClaudeCapture {
  private readonly pairs = new Map<string, Pair>();
  private readonly unknown = new Set<string>();
  private readonly backgroundTasks = new Map<string, Pair>();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<boolean>>();
  private bytes = 0;
  private closed = false;
  private readonly names: Set<string>;
  private readonly observe: ClaudeCapturePort['observe'];
  private readonly observeBatch: ClaudeCapturePort['observeBatch'];
  private readonly observeBackground: ClaudeCapturePort['observeBackground'];
  private readonly options: CaptureOptions;
  constructor(options: CaptureOptions) { this.options = options; this.names = new Set(options.names); this.observe = options.port.observe; this.observeBatch = options.port.observeBatch; this.observeBackground = options.port.observeBackground; }
  get completesBatches(): boolean { return this.observeBatch !== undefined; }
  get retainsBackground(): boolean { return this.observeBackground !== undefined; }

  readonly hook: HookCallback = async (raw, toolUseId, { signal }) => {
    if (!this.accepts(raw, toolUseId) || this.closed) {return {};}
    if (raw.hook_event_name === 'PreToolUse') {await this.before(raw, signal);}
    else {await this.after(raw, signal);}
    return {};
  };
  private async before(raw: ToolHook, signal: AbortSignal): Promise<void> {
    const identity = { sessionRef: this.options.sessionRef, toolUseId: raw.tool_use_id, toolName: raw.tool_name };
    const pair = this.pairs.get(raw.tool_use_id);
    if (this.unknown.has(raw.tool_use_id)) {return;}
    if (pair) {
      await this.validateTool(pair, raw);
      await pair.before; return; // A duplicate cannot bypass an outstanding preimage.
    }
    const owner = this.options.currentOwner(raw.tool_use_id, raw.tool_name);
    if (!owner || owner.revoked.aborted || signal.aborted) {
      await this.unboundGap(identity, 'unattributed'); return;
    }
    if (this.pairs.size + this.unknown.size >= this.options.maxPairs) {
      await this.unboundGap(identity, 'limit'); return;
    }
    let input: ClaudeCaptureValue;
    try { input = copyValue(raw.tool_input, Math.min(64 * 1024, this.options.maxBytes)); }
    catch { await this.unboundGap(identity, 'oversized'); return; }
    const serialized = JSON.stringify(input), fingerprint = inputDigest(input), bytes = Buffer.byteLength(serialized);
    if (this.bytes + bytes > this.options.maxBytes) { await this.unboundGap(identity, 'limit'); return; }
    const captured: Pair = { identity: { ...identity, inputId: owner.inputId, operationRef: owner.operationRef },
      owner: { ...owner }, input, fingerprint, bytes, abort: new AbortController(), phase: 'preparing' };
    this.pairs.set(raw.tool_use_id, captured); this.bytes += bytes;
    if (this.observeBatch !== undefined || this.observeBackground !== undefined) {
      const revoked = () => {if (captured.phase !== 'completed' && captured.phase !== 'gap') {void this.gap(captured, 'stale');}};
      owner.revoked.addEventListener('abort', revoked, { once: true });
      captured.detach = () => { owner.revoked.removeEventListener('abort', revoked); };
    }
    let releaseBefore!: () => void;
    captured.before = new Promise<void>(resolve => { releaseBefore = resolve; });
    try {
      const overlapping = [...this.pairs.values()].filter(other => other !== captured && other.background?.registered === true && live(other));
      if (overlapping.length) { await Promise.all([...overlapping, captured].map(value => this.gap(value, 'batch-unqualified'))); return; }
      const ok = await this.notify({ ...captured.identity, phase: 'before', toolInput: input }, [signal, owner.revoked, captured.abort.signal]);
      if (!inPhase(captured, 'preparing')) {return;}
      if (!ok) {await this.gap(captured, 'capture-failed');}
      else if (!this.current(captured) || aborted(signal)) {await this.gap(captured, 'stale');}
      else {captured.phase = 'prepared';}
    } finally { releaseBefore(); }
    return;
  }
  private async after(raw: ToolHook, signal: AbortSignal): Promise<void> {
    const identity = { sessionRef: this.options.sessionRef, toolUseId: raw.tool_use_id, toolName: raw.tool_name };
    const pair = this.pairs.get(raw.tool_use_id);
    if (!pair) { await this.unboundGap(identity, 'unattributed'); return; }
    if (pair.phase === 'gap' || !await this.validateTool(pair, raw)) {return;}
    const outcome = raw.hook_event_name === 'PostToolUseFailure' ? 'failed' : 'succeeded';
    if (['finished', 'finishing', 'completing', 'background', 'background-completing', 'completed'].includes(pair.phase)) {
      if (pair.outcome !== outcome) {await this.gap(pair, 'conflict');}
      else {await pair.background?.registration;}
      return;
    }
    if (pair.phase !== 'prepared' || !this.current(pair) || signal.aborted) { await this.gap(pair, 'stale'); return; }
    pair.phase = 'finishing'; pair.outcome = outcome;
    const ok = await this.notify({ ...pair.identity, phase: 'after', toolInput: pair.input!, outcome }, [signal, pair.owner.revoked, pair.abort.signal]);
    if (!inPhase(pair, 'finishing')) {return;}
    if (!ok) {await this.gap(pair, 'capture-failed');}
    else if (!this.current(pair) || aborted(signal)) {await this.gap(pair, 'stale');}
    else {
      pair.phase = 'finished';
      if (background(raw) && this.observeBackground) {await this.registerBackground(pair, raw);}
      else if (!this.observeBatch) {pair.phase = 'completed'; this.release(pair);}
      else if (background(raw)) {await this.gap(pair, 'background');}
      else {pair.timer = setTimeout(() => {if (pair.phase === 'finished') {void this.gap(pair, 'missing-batch');}}, this.options.timeoutMs); pair.timer.unref();}
    }
    return;
  }

  /** SDK supplies the complete batch tool IDs; never infer them from the currently active input. */
  readonly batchHook: HookCallback = async (raw, _transportId, { signal }) => {
    // The CLI supplies a synthetic hook-UUID here. Only tool_calls carries native tool identity.
    if (!this.observeBatch || this.closed || raw.hook_event_name !== 'PostToolBatch' ||
        raw.session_id !== this.options.nativeSession || raw.agent_id !== undefined) {return {};}
    const calls = raw.tool_calls;
    if (!Array.isArray(calls) || !calls.length || calls.length > this.options.maxPairs) {return {};}
    const known = await this.batchPairs(calls); if (!known) {return {};}
    const reject = async (reason: GapReason) => {await Promise.all(known.map(pair => this.gap(pair, reason)));};
    if (known.some(pair => pair.background?.registered === true)) {
      if (known.length !== 1) {await reject('batch-unqualified');}
      return {}; // A background placeholder batch never proves eventual completion.
    }
    const first = known[0]!;
    if (known.some(pair => pair.identity.inputId !== first.identity.inputId ||
        pair.identity.operationRef !== first.identity.operationRef || pair.owner.nativeRef !== first.owner.nativeRef ||
        pair.owner.revoked !== first.owner.revoked)) {await reject('batch-unqualified'); return {};}
    const batch = digest(JSON.stringify(calls.map(call => [call.tool_use_id, call.tool_name])));
    if (known.some(pair => pair.batch !== undefined && pair.batch.length > 0 && pair.batch !== batch)) {await reject('conflict'); return {};}
    if (known.every(pair => pair.phase === 'completed' || pair.phase === 'completing')) {
      await Promise.all(known.map(pair => pair.settlement ?? Promise.resolve())); return {};
    }
    if (known.some(pair => pair.phase === 'gap')) {await reject('batch-unqualified'); return {};}
    if (known.some(pair => pair.phase !== 'finished' || !this.current(pair)) || signal.aborted) {await reject('stale'); return {};}
    await this.completeBatch(known, batch, signal); return {};
  };
  private async completeBatch(known: Pair[], batch: string, signal: AbortSignal): Promise<void> {
    const first = known[0]!;
    const reject = async (reason: GapReason) => {await Promise.all(known.map(pair => this.gap(pair, reason)));};
    const tools = Object.freeze(known.map(pair => Object.freeze({ toolUseId: pair.identity.toolUseId, toolName: pair.identity.toolName,
      toolInput: pair.input!, outcome: pair.outcome! })));
    for (const pair of known) { clearTimeout(pair.timer); pair.phase = 'completing'; pair.batch = batch; }
    // Publish the flight before invoking the consumer, including synchronous re-entrant duplicates.
    let release!: () => void;
    const settlement = new Promise<void>(resolve => { release = resolve; });
    for (const pair of known) {pair.settlement = settlement;}
    try {
      const ok = await this.notifyBatch({ sessionRef: this.options.sessionRef, inputId: first.identity.inputId,
        operationRef: first.identity.operationRef, boundary: 'post-tool-use-hooks', tools }, [signal, first.owner.revoked, ...known.map(pair => pair.abort.signal)]);
      if (known.some(pair => pair.phase !== 'completing')) {await reject('conflict');}
      else if (!ok) {await reject('capture-failed');}
      else if (known.some(pair => !this.current(pair)) || signal.aborted) {await reject('stale');}
      else {for (const pair of known) {pair.phase = 'completed'; this.release(pair);}}
    } finally {release();}
  }

  private async batchPairs(calls: readonly BatchCall[]): Promise<Pair[] | undefined> {
    const pairs = calls.map(call => this.pairs.get(call.tool_use_id));
    const known = [...new Set(pairs.filter((pair): pair is Pair => !!pair))];
    if (known.length !== calls.length) {
      for (const call of calls) {await this.unknownBatchCall(call);}
      await Promise.all(known.map(pair => this.gap(pair, 'batch-unqualified'))); return;
    }
    for (let index = 0; index < calls.length; index++) {
      if (!await this.validateTool(pairs[index]!, calls[index]!)) {
        await Promise.all(known.map(pair => this.gap(pair, 'conflict'))); return;
      }
    }
    return known;
  }
  private async unknownBatchCall(call: BatchCall): Promise<void> {
    if (!this.pairs.has(call.tool_use_id) && typeof call.tool_use_id === 'string' && call.tool_use_id.length > 0 && call.tool_use_id.length <= 1024 && this.names.has(call.tool_name)) {
      await this.unboundGap({ sessionRef: this.options.sessionRef, toolUseId: call.tool_use_id, toolName: call.tool_name }, 'unattributed');
    }
  }

  /** Terminal cannot release a subsequent input while an original batch observation is pending. */
  async finishInput(input: Readonly<{ inputId: string; operationRef: string }>, terminal?: 'succeeded' | 'failed' | 'unknown'): Promise<void> {
    if (!this.observeBatch && !this.observeBackground) {return;}
    const retained = [...this.pairs.values()].filter(pair => pair.identity.inputId === input.inputId && pair.identity.operationRef === input.operationRef);
    for (const pair of retained.filter(value => value.background?.registered === true && live(value))) {
      if (terminal !== 'succeeded' && terminal !== 'failed') {await this.gap(pair, 'stale'); continue;}
      // Retain provenance for observation only. No callback/permission or next-input authority survives.
      pair.background!.retained = true; pair.detach?.(); delete pair.detach;
    }
    const foreground = retained.filter(pair => pair.background?.registered !== true);
    if (this.observeBatch) {
      await Promise.all(foreground.map(pair => pair.settlement ?? Promise.resolve()));
      await Promise.all(foreground.filter(live).map(pair => this.gap(pair, 'missing-batch')));
    }
  }

  /** Join only actual native task bookends to an already captured main-thread Bash call. */
  async acceptTask(raw: Record<string, unknown>): Promise<boolean> {
    if (!this.observeBackground || this.closed || !nativeTask(raw, this.options.nativeSession)) {return false;}
    const mapped = this.backgroundTasks.get(raw.task_id), byTool = nativeId(raw.tool_use_id) ? this.pairs.get(raw.tool_use_id) : undefined;
    const pair = mapped ?? byTool;
    if (!pair || pair.identity.toolName !== 'Bash') {return false;}
    if (!live(pair)) {
      if (raw.subtype === 'task_notification' && pair.background?.terminal && raw.status !== pair.background.terminal) {await this.gap(pair, 'conflict');}
      return true;
    }
    if (taskConflict(raw, pair, byTool)) {
      await this.gap(pair, 'conflict'); return true;
    }
    if (!await this.associateTask(pair, raw.task_id, raw.run_id as string | undefined)) {return true;}
    if (raw.subtype === 'task_notification') {
      const status = raw.status;
      if (!taskStatus(status)) {await this.gap(pair, 'conflict'); return true;}
      if (pair.background!.terminal && pair.background!.terminal !== status) {await this.gap(pair, 'conflict'); return true;}
      pair.background!.terminal = status;
      if (pair.background!.registered) {await this.completeBackground(pair);}
    }
    return true;
  }
  private async associateTask(pair: Pair, taskRef: string, runRef?: string): Promise<boolean> {
    const previous = this.backgroundTasks.get(taskRef), selected = pair.background;
    // Optional native run IDs must have the same presence/value on both bookends; asymmetry stays an explicit gap.
    if ((previous && previous !== pair) || (selected && (selected.taskRef !== taskRef || selected.runRef !== runRef))) {
      await Promise.all([...new Set([pair, ...(previous ? [previous] : [])])].map(value => this.gap(value, 'conflict'))); return false;
    }
    pair.background ??= { taskRef, ...(runRef === undefined ? {} : { runRef }), registered: false, retained: false };
    this.backgroundTasks.set(taskRef, pair); return true;
  }
  private async registerBackground(pair: Pair, raw: ToolHook): Promise<void> {
    const response = 'tool_response' in raw ? raw.tool_response : undefined;
    const taskRef = ownString(response, 'backgroundTaskId') ?? pair.background?.taskRef;
    if (taskRef === undefined || taskRef.length === 0 || pair.identity.toolName !== 'Bash' || !await this.associateTask(pair, taskRef, pair.background?.runRef)) {await this.gap(pair, 'background'); return;}
    const overlapping = [...this.pairs.values()].filter(other => other !== pair && live(other));
    if (overlapping.length) {await Promise.all([pair, ...overlapping].map(value => this.gap(value, 'batch-unqualified'))); return;}
    const selected = pair.background!; selected.registered = true; pair.phase = 'background';
    pair.timer = setTimeout(() => {if (live(pair)) {void this.gap(pair, 'background');}}, this.options.timeoutMs); pair.timer.unref();
    let release!: () => void; selected.registration = new Promise<void>(resolve => { release = resolve; });
    try {
      const ok = await this.notifyBackground(pair, { phase: 'registered', boundary: 'native-background-registration' });
      if (!live(pair)) {return;}
      if (!ok) {await this.gap(pair, 'capture-failed');}
      else if (!this.currentBackground(pair)) {await this.gap(pair, 'stale');}
    } finally {release();}
    if (selected.terminal && live(pair)) {await this.completeBackground(pair);}
  }
  private async completeBackground(pair: Pair): Promise<void> {
    const selected = pair.background!;
    if (selected.completion) {await selected.completion; return;}
    await selected.registration;
    const completing = completion(selected);
    if (completing !== undefined) {await completing; return;}
    if (!live(pair) || !selected.terminal) {return;}
    if (!this.currentBackground(pair)) {await this.gap(pair, 'stale'); return;}
    pair.phase = 'background-completing';
    let release!: () => void; selected.completion = new Promise<void>(resolve => { release = resolve; });
    try {
      const ok = await this.notifyBackground(pair, { phase: 'terminal', boundary: 'native-task-notification', status: selected.terminal });
      if (!live(pair)) {return;}
      if (!ok) {await this.gap(pair, 'capture-failed');}
      else if (!this.currentBackground(pair)) {await this.gap(pair, 'stale');}
      else if (selected.terminal === 'stopped') {await this.gap(pair, 'background');}
      else {pair.phase = 'completed'; this.release(pair);}
    } finally {release();}
  }
  private currentBackground(pair: Pair): boolean {
    return !this.closed && !pair.abort.signal.aborted && (pair.background?.retained === true || this.current(pair));
  }
  private notifyBackground(pair: Pair, observation: Omit<Extract<BackgroundRequest, { phase: 'registered' }>, keyof BoundTool | 'taskRef' | 'runRef' | 'toolInput' | 'signal'> |
    Omit<Extract<BackgroundRequest, { phase: 'terminal' }>, keyof BoundTool | 'taskRef' | 'runRef' | 'toolInput' | 'signal'>): Promise<boolean> {
    const selected = pair.background!;
    return this.deliver(signal => this.observeBackground!(Object.freeze({ ...pair.identity, taskRef: selected.taskRef,
      ...(selected.runRef === undefined ? {} : { runRef: selected.runRef }), toolInput: pair.input!, ...observation, signal })), [pair.abort.signal]);
  }

  /** Retire original observation leases without disabling a recoverable session's future pairs. */
  async revoke(): Promise<void> {
    await Promise.all([...this.pairs.values()].filter(live).map(pair => this.gap(pair, 'stale')));
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true; this.lifetime.abort();
      for (const pair of this.pairs.values()) {
        if (pair.phase !== 'completed' && (this.observeBatch !== undefined || pair.phase !== 'finished') && pair.phase !== 'gap') {void this.gap(pair, 'closed');}
      }
      this.pairs.clear(); this.backgroundTasks.clear(); this.unknown.clear(); this.bytes = 0;
    }
    await Promise.all(this.pending);
  }
  private accepts(raw: HookInput, id: string | undefined): raw is ToolHook {
    return ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(raw.hook_event_name) &&
      raw.session_id === this.options.nativeSession && raw.agent_id === undefined &&
      'tool_name' in raw && this.names.has(raw.tool_name) && 'tool_use_id' in raw &&
      typeof id === 'string' && id.length > 0 && id.length <= 1024 && raw.tool_use_id === id;
  }
  private current(pair: Pair): boolean {
    const owner = this.options.currentOwner(pair.identity.toolUseId, pair.identity.toolName);
    return !this.closed && !pair.owner.revoked.aborted && !!owner && owner.nativeRef === pair.owner.nativeRef &&
      owner.revoked === pair.owner.revoked && owner.inputId === pair.identity.inputId && owner.operationRef === pair.identity.operationRef;
  }
  private release(pair: Pair): void {
    clearTimeout(pair.timer); pair.detach?.(); delete pair.detach;
    this.bytes = Math.max(0, this.bytes - pair.bytes); pair.bytes = 0; delete pair.input;
  }
  private async validateTool(pair: Pair, raw: Pick<ToolHook, 'tool_name' | 'tool_input'>): Promise<boolean> {
    if (pair.identity.toolName !== raw.tool_name) { await this.gap(pair, 'conflict'); return false; }
    try {
      if (inputDigest(copyValue(raw.tool_input, Math.min(64 * 1024, this.options.maxBytes))) === pair.fingerprint) {return true;}
    } catch { await this.gap(pair, 'oversized'); return false; }
    await this.gap(pair, 'conflict'); return false;
  }
  private async gap(pair: Pair, reason: GapReason): Promise<void> {
    pair.phase = 'gap'; if (this.observeBatch !== undefined || this.observeBackground !== undefined) {pair.abort.abort();} this.release(pair);
    if (pair.gapSent === true) {return;}
    pair.gapSent = true;
    await this.notify({ ...pair.identity, phase: 'gap', reason }, [], true);
  }
  private async unboundGap(identity: ToolIdentity, reason: Extract<ClaudeCaptureRequest, { phase: 'gap' }>['reason']): Promise<void> {
    // One bounded session-level overflow notice; never evict an old pair into a new input.
    const key = this.pairs.size + this.unknown.size >= this.options.maxPairs ? 'overflow' : identity.toolUseId;
    if (this.unknown.has(key)) {return;}
    this.unknown.add(key);
    await this.notify({ ...identity, phase: 'gap', reason }, [], true);
  }
  private notify(request: WithoutSignal, signals: AbortSignal[], gap = false): Promise<boolean> {
    return this.deliver(signal => this.observe(Object.freeze({ ...request, signal })), signals, gap);
  }
  private notifyBatch(request: Omit<ClaudeCaptureBatchRequest, 'signal'>, signals: AbortSignal[]): Promise<boolean> {
    return this.deliver(signal => this.observeBatch!(Object.freeze({ ...request, signal })), signals);
  }
  private deliver(observe: (signal: AbortSignal) => Promise<void>, signals: AbortSignal[], gap = false): Promise<boolean> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...signals, ...(gap ? [] : [this.lifetime.signal])]);
    const timer = setTimeout(() => { controller.abort(); }, this.options.timeoutMs);
    let onAbort!: () => void;
    const work = (async () => {
      try {
        const observed = Promise.resolve(observe(signal));
        await Promise.race([observed, new Promise<never>((_resolve, reject) => {
          onAbort = () => { reject(new Error('Capture unavailable')); };
          signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) {onAbort();}
        })]);
        return !signal.aborted;
      } catch { return false; }
      finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
    })();
    this.pending.add(work); void work.finally(() => { this.pending.delete(work); });
    return work;
  }
}
type GapReason = Extract<ClaudeCaptureRequest, { phase: 'gap' }>['reason'];
// Read lifecycle state again after awaited consumer callbacks; earlier narrowing is not a fence.
function inPhase(pair: Pair, phase: Pair['phase']): boolean { return pair.phase === phase; }
function aborted(signal: AbortSignal): boolean { return signal.aborted; }
function completion(selected: NonNullable<Pair['background']>): Promise<void> | undefined { return selected.completion; }
function live(pair: Pair): boolean { return pair.phase !== 'completed' && pair.phase !== 'gap'; }
function nativeId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/u.test(value); }
function taskStatus(value: unknown): value is 'completed' | 'failed' | 'stopped' {
  return value === 'completed' || value === 'failed' || value === 'stopped';
}
function nativeTask(raw: Record<string, unknown>, session: string): raw is Record<string, unknown> & { task_id: string } {
  return raw.type === 'system' && ['task_started', 'task_notification'].includes(String(raw.subtype)) &&
    raw.session_id === session && nativeId(raw.task_id);
}
function taskConflict(raw: Record<string, unknown>, pair: Pair, byTool: Pair | undefined): boolean {
  return ((byTool !== undefined && byTool !== pair) || (raw.tool_use_id !== undefined && raw.tool_use_id !== pair.identity.toolUseId) ||
    (raw.run_id !== undefined && !nativeId(raw.run_id)) || raw.agent_id !== undefined || raw.parent_task_id !== undefined ||
    raw.owned_by_subagent === true || (raw.subtype === 'task_started' && raw.task_type !== 'local_bash'));
}
function ownString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') {return;}
  const property = Object.getOwnPropertyDescriptor(value, key);
  const owned: unknown = property !== undefined && 'value' in property ? property.value : undefined;
  return nativeId(owned) ? owned : undefined;
}
function background(raw: ToolHook): boolean {
  const input: unknown = raw.tool_input, response: unknown = 'tool_response' in raw ? raw.tool_response : undefined;
  return (input !== null && typeof input === 'object' && 'run_in_background' in input && input.run_in_background === true) ||
    (response !== null && typeof response === 'object' && 'backgroundTaskId' in response && typeof response.backgroundTaskId === 'string');
}
type WithoutSignal = ClaudeCaptureRequest extends infer R ? R extends ClaudeCaptureRequest ? Omit<R, 'signal'> : never : never;
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function inputDigest(value: ClaudeCaptureValue): string {
  // Native hook phases may reorder defaulted object keys; arrays and every value remain significant.
  return digest(JSON.stringify(value, (_key, item: ClaudeCaptureValue) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {return item;}
    const fields = item as Readonly<Record<string, ClaudeCaptureValue>>;
    return Object.fromEntries(Object.keys(fields).toSorted().map(key => [key, fields[key]]));
  }));
}
function copyValue(value: unknown, maxBytes: number): ClaudeCaptureValue {
  let nodes = 1024, bytes = maxBytes;
  const seen = new Set<unknown>();
  const copy = (item: unknown, depth: number): ClaudeCaptureValue => {
    if (--nodes < 0 || depth > 8) {throw new Error('Capture input limit');}
    if (item === null || typeof item === 'boolean') {return item;}
    if (typeof item === 'number' && Number.isFinite(item)) {return item;}
    if (typeof item === 'string') { bytes -= Buffer.byteLength(item); if (bytes < 0) {throw new Error('Capture input limit');} return item; }
    if (typeof item !== 'object' || seen.has(item)) {throw new Error('Capture input shape');}
    seen.add(item);
    try {
      if (Array.isArray(item)) {return Object.freeze(Array.from(item, entry => copy(entry, depth + 1)));}
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {throw new Error('Capture input shape');}
      const result: Record<string, ClaudeCaptureValue> = {};
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        bytes -= Buffer.byteLength(key);
        if (!descriptor || !('value' in descriptor) || bytes < 0) {throw new Error('Capture input shape');}
        Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
      }
      return Object.freeze(result);
    } finally { seen.delete(item); }
  };
  return copy(value, 0);
}
