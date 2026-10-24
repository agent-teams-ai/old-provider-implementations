import type { HookCallback, Options, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload } from '@agent-teams/provider-session-contracts';
import type { ForegroundToolOwner } from './tool-binding.ts';
import { Normalizer, OutputLimitError, record } from './normalize.ts';
import { deferred } from '../provider-session-io/io.ts';

/** Provider-owned optional observation. These facts carry no Team principal or grant. */
type BoundChild = Readonly<{ inputId: string; operationRef: string; parentToolRef: string; childRef: string }>;
export type ClaudeSubagentObservation = Readonly<{ sessionRef: string; signal: AbortSignal }> & (
  | (BoundChild & Readonly<{ phase: 'started' | 'completed' | 'failed' | 'stopped' }>)
  | (BoundChild & Readonly<{ phase: 'fact'; fact: Exclude<EventPayload, { kind: 'usage' | 'result' | 'interaction' }> }>)
  | (BoundChild & Readonly<{ phase: 'interaction'; toolRef: string; fact: Extract<EventPayload, { kind: 'interaction' }> }>)
  | (BoundChild & Readonly<{ phase: 'usage'; totalTokens: number; toolUses: number; durationMs: number }>)
  | (Partial<BoundChild> & Readonly<{ phase: 'gap'; reason: 'unattributed' | 'stale' | 'conflict' | 'limit' }>)
);
export type ClaudeSubagentAuthorization = Readonly<{ sessionRef: string; inputId: string; operationRef: string; parentToolRef: string; signal: AbortSignal }>;
export type ClaudeSubagentPort = Readonly<{
  /** Trusted caller enables ordinary foreground delegation only in the selected DO mode. */
  mode: 'do';
  /** Exact native tool names, a subset of the parent's selected tools. No MCP or delegation. */
  tools: readonly string[];
  authorize(request: ClaudeSubagentAuthorization): Promise<boolean>;
  observe(request: ClaudeSubagentObservation): Promise<void>;
}>;
type Detail = ClaudeSubagentObservation extends infer R ? R extends ClaudeSubagentObservation ? Omit<R, 'sessionRef' | 'inputId' | 'operationRef' | 'parentToolRef' | 'childRef' | 'signal'> : never : never;
type Owner = ForegroundToolOwner;
type Child = { parentToolRef: string; owner: Owner; normalizer: Normalizer; ended: boolean };
const agentType = 'host-ordinary';
const forbidden = /^(?:Team|Task|TodoWrite|Agent|Cron|Schedule|SendMessage$|ListAgents$|mcp__)/;
export function validSubagents(value: unknown, tools: readonly string[]): boolean {
  const port = subagentFields(value) ? value : {};
  return value === undefined || (Boolean(value) && port.mode === 'do' && Array.isArray(port.tools) &&
    port.tools.length > 0 && port.tools.length <= 256 && new Set(port.tools).size === port.tools.length &&
    port.tools.every((name: unknown) => typeof name === 'string' && name.length > 0 && name.length <= 256 && !forbidden.test(name) && tools.includes(name)) &&
    tools.includes('Agent') && typeof port.authorize === 'function' && typeof port.observe === 'function' &&
    Object.keys(port).every(key => ['mode', 'tools', 'authorize', 'observe'].includes(key)));
}
function subagentFields(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}
export function subagentOptions(port: ClaudeSubagentPort): Pick<Options, 'agents' | 'forwardSubagentText'> {
  return { forwardSubagentText: true, agents: { [agentType]: {
    description: 'Ordinary foreground subagent for this operation.', prompt: 'Complete the delegated work within your available tools.',
    tools: [...port.tools], disallowedTools: ['mcp__*', 'Agent', 'TeamCreate', 'TaskCreate', 'TaskUpdate', 'SendMessage'],
    background: false, model: 'inherit',
  } } };
}
type Denial = 'native-session' | 'cancelled' | 'native-tool-id' | 'child-scope' | 'native-team-tool' | 'parent-owner' | 'parent-input' | 'limit' | 'parent-authority' | 'parent-conflict';
const deny = (reason: Denial) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const,
  permissionDecision: 'deny' as const, permissionDecisionReason: `Ordinary subagent scope unavailable (${reason})` } });

/** Native task_id and tool_use_id bind a child; model arguments never select an owner. */
export class ClaudeSubagents {
  private readonly parents = new Map<string, Owner>();
  private readonly toolOwners = new Map<string, { childRef: string; name: string }>();
  private readonly children = new Map<string, Child>();
  private childAssociationChanged = deferred<void>();
  private pendingChildren = 0;
  private readonly lifetime = new AbortController();
  private count = 0;
  private bytes = 0;
  private nativeFrames = 0;
  private nativeBytes = 0;
  private readonly config: {
    port: ClaudeSubagentPort; sessionRef: string; nativeSession: string; maxEvents: number; maxBytes: number; timeoutMs: number;
    currentOwner(id: string, name: string): Owner | undefined;
    awaitOwner(id: string, name: string, signal: AbortSignal): Promise<Owner | undefined>;
  };
  constructor(config: ClaudeSubagents['config']) { this.config = config; }
  readonly hook: HookCallback = async (raw, id, { signal }) => {
    if (raw.hook_event_name !== 'PreToolUse') {return {};}
    if (raw.session_id !== this.config.nativeSession) {return deny('native-session');}
    if (signal.aborted || this.lifetime.signal.aborted) {return deny('cancelled');}
    if (typeof id !== 'string' || !id || id !== raw.tool_use_id) {return deny('native-tool-id');}
    if (raw.agent_id !== undefined) {return this.childHook(raw, id, raw.agent_id, signal);}
    if (raw.tool_name !== 'Agent') {
      return /^(?:Team|Task|TodoWrite|Cron|Schedule|SendMessage$|ListAgents$)/.test(raw.tool_name) ? deny('native-team-tool') : {};
    }
    return this.parentHook(raw, id, signal);
  };
  private async childHook(raw: PreToolUseHookInput, id: string, childRef: string, signal: AbortSignal) {
    const child = this.children.get(childRef) ?? await this.awaitChild(childRef, signal);
    if (!child || child.ended || !this.current(child) || !this.config.port.tools.includes(raw.tool_name)) {return deny('child-scope');}
    const prior = this.toolOwners.get(id);
    if ((prior && (prior.childRef !== childRef || prior.name !== raw.tool_name)) || (!prior && this.toolOwners.size >= this.config.maxEvents)) {return deny('child-scope');}
    this.toolOwners.set(id, { childRef, name: raw.tool_name });
    return {}; // Existing native permission mode and canUseTool still decide; this never grants.
  }
  private async awaitChild(childRef: string, signal: AbortSignal): Promise<Child | undefined> {
    const parents = [...this.parents].filter(([id, owner]) => sameOwner(this.config.currentOwner(id, 'Agent'), owner)).map(([, owner]) => owner);
    if (!parents.length || this.pendingChildren >= this.config.maxEvents) {return undefined;}
    this.pendingChildren++;
    const scope = AbortSignal.any([signal, this.lifetime.signal, ...parents.map(owner => owner.revoked), AbortSignal.timeout(this.config.timeoutMs)]);
    let abort!: () => void;
    const ended = new Promise<void>(resolve => { abort = resolve; scope.addEventListener('abort', abort, { once: true }); if (scope.aborted) {abort();} });
    try {
      while (!scope.aborted) {
        const child = this.children.get(childRef);
        if (child) {return parents.some(owner => sameOwner(child.owner, owner)) ? child : undefined;}
        await Promise.race([this.childAssociationChanged.promise, ended]);
      }
      return undefined;
    } finally { scope.removeEventListener('abort', abort); this.pendingChildren--; }
  }
  private async parentHook(raw: PreToolUseHookInput, id: string, signal: AbortSignal) {
    const owner = this.config.currentOwner(id, 'Agent') ?? await this.config.awaitOwner(id, 'Agent', signal);
    if (!owner || owner.revoked.aborted) {return deny('parent-owner');}
    if (!ordinaryInvocation(raw.tool_input)) {return deny('parent-input');}
    if (this.parents.size >= this.config.maxEvents) {return deny('limit');}
    if (!await this.authorizeParent(id, owner, signal)) {return deny('parent-authority');}
    const prior = this.parents.get(id);
    if (prior && prior.nativeRef !== owner.nativeRef) {return deny('parent-conflict');}
    this.parents.set(id, owner);
    return {};
  }
  private async authorizeParent(id: string, owner: Owner, signal: AbortSignal): Promise<boolean> {
    const scope = AbortSignal.any([signal, owner.revoked, this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    let abort: (() => void) | undefined;
    try {
      const allowed: unknown = await Promise.race([this.config.port.authorize(Object.freeze({ sessionRef: this.config.sessionRef, inputId: owner.inputId, operationRef: owner.operationRef, parentToolRef: id, signal: scope })),
        new Promise<never>((_resolve, reject) => { abort = () => { reject(new Error('Subagent authorization unavailable')); }; scope.addEventListener('abort', abort, { once: true }); if (scope.aborted) {abort();} })]);
      return allowed === true && !scope.aborted && sameOwner(this.config.currentOwner(id, 'Agent'), owner);
    } catch { return false; } finally { if (abort !== undefined) {scope.removeEventListener('abort', abort);} }
  }
  /** True consumes a native child frame so it never enters the parent's common feed. */
  async accept(raw: Record<string, unknown>): Promise<boolean> {
    const taskEvent = isTaskEvent(raw);
    if (!taskEvent && !isNested(raw)) {return false;}
    if (raw.session_id !== this.config.nativeSession) {return true;}
    const { childRef, parentToolRef } = this.references(raw);
    const child = this.children.get(childRef);
    if (taskEvent && !child && raw.task_type !== 'local_agent' && !this.parents.has(parentToolRef)) {return false;}
    this.boundNative(raw);
    if (!child && await this.registerStart(raw, childRef, parentToolRef)) {return true;}
    if (!child) {await this.unattributed(childRef, parentToolRef); return true;}
    await this.acceptChild(raw, childRef, parentToolRef, child);
    return true;
  }
  private references(raw: Record<string, unknown>): { childRef: string; parentToolRef: string } {
    let childRef = nativeReference(raw.agent_id, raw.task_id);
    const parentToolRef = nativeReference(raw.parent_tool_use_id, raw.tool_use_id);
    // Partial and user envelopes omit agent_id; the spawning native tool is an exact alternate join.
    if (!childRef && parentToolRef) {
      const matches = [...this.children].filter(([, candidate]) => candidate.parentToolRef === parentToolRef);
      if (matches.length === 1) {childRef = matches[0]![0];}
    }
    return { childRef, parentToolRef };
  }
  private boundNative(raw: Record<string, unknown>): void {
    this.nativeFrames++; this.nativeBytes += Buffer.byteLength(JSON.stringify(raw));
    if (this.nativeFrames > this.config.maxEvents || this.nativeBytes > this.config.maxBytes) {throw new OutputLimitError('Subagent native output limit');}
  }
  private async registerStart(raw: Record<string, unknown>, childRef: string, parentToolRef: string): Promise<boolean> {
    if (!ordinaryStart(raw) || !childRef || !parentToolRef) {return false;}
    const owner = this.config.currentOwner(parentToolRef, 'Agent');
    if (!owner || [...this.children.values()].some(candidate => candidate.parentToolRef === parentToolRef) ||
        this.parents.get(parentToolRef)?.nativeRef !== owner.nativeRef || owner.revoked.aborted || this.children.size >= this.config.maxEvents) {return false;}
    const child = { parentToolRef, owner, normalizer: new Normalizer(this.config.maxBytes), ended: false };
    this.children.set(childRef, child);
    this.childAssociationChanged.resolve(); this.childAssociationChanged = deferred<void>();
    await this.emit(childRef, child, { phase: 'started' });
    return true;
  }
  private async unattributed(childRef: string, parentToolRef: string): Promise<void> {
    // No guessed association, no synthetic child identity. A known parent may carry an explicit gap.
    const owner = this.parents.get(parentToolRef);
    await this.deliver({ sessionRef: this.config.sessionRef, phase: 'gap', reason: 'unattributed',
      ...(childRef ? { childRef } : {}), ...(parentToolRef ? { parentToolRef } : {}),
      ...(owner ? { inputId: owner.inputId, operationRef: owner.operationRef } : {}) });
  }
  private async acceptChild(raw: Record<string, unknown>, childRef: string, parentToolRef: string, child: Child): Promise<void> {
    const conflict = parentToolRef.length > 0 && parentToolRef !== child.parentToolRef;
    if (conflict || !this.current(child) || child.ended) {
      await this.emit(childRef, child, { phase: 'gap', reason: conflict ? 'conflict' : 'stale' }); return;
    }
    if (raw.subtype === 'task_notification') {
      const phase = raw.status;
      if (phase === 'completed' || phase === 'failed' || phase === 'stopped') {
        child.ended = true; await this.emit(childRef, child, { phase });
      }
      return;
    }
    if (raw.subtype === 'task_progress') {await this.progress(raw, childRef, child); return;}
    await this.childFacts(raw, childRef, child);
  }
  private async progress(raw: Record<string, unknown>, childRef: string, child: Child): Promise<void> {
    const usage = record(raw.usage);
    if ([usage.total_tokens, usage.tool_uses, usage.duration_ms].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      await this.emit(childRef, child, { phase: 'usage', totalTokens: usage.total_tokens as number, toolUses: usage.tool_uses as number, durationMs: usage.duration_ms as number });
    }
  }
  private async childFacts(raw: Record<string, unknown>, childRef: string, child: Child): Promise<void> {
    if (raw.type !== 'assistant' && raw.type !== 'user' && raw.type !== 'stream_event') {return;}
    for (const fact of child.normalizer.normalize(raw).facts) {
      if (fact.kind !== 'usage' && fact.kind !== 'result' && fact.kind !== 'interaction') {await this.emit(childRef, child, { phase: 'fact', fact });}
    }
  }
  ownsTool(toolRef: string): boolean { return this.toolOwners.has(toolRef); }
  canInteract(childRef: string, toolRef: string, name: string): boolean {
    const child = this.children.get(childRef), tool = this.toolOwners.get(toolRef);
    return !!child && !child.ended && this.current(child) && tool?.childRef === childRef && tool.name === name && this.config.port.tools.includes(name);
  }
  async interaction(childRef: string, toolRef: string, fact: Extract<EventPayload, { kind: 'interaction' }>): Promise<void> {
    const child = this.children.get(childRef);
    const name = fact.request.kind === 'permission' ? fact.request.tool : 'AskUserQuestion';
    if (!child || !this.canInteract(childRef, toolRef, name)) {throw new Error('Child interaction unavailable');}
    await this.deliver({ sessionRef: this.config.sessionRef, inputId: child.owner.inputId, operationRef: child.owner.operationRef,
      parentToolRef: child.parentToolRef, childRef, phase: 'interaction', toolRef, fact }, child.owner.revoked);
    if (!this.canInteract(childRef, toolRef, name)) {throw new Error('Child interaction stale');}
  }
  /** Stop requests are acknowledgements, never terminal or physical custody evidence. */
  async stopOwned(stopTask: (childRef: string) => Promise<void>): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.children].filter(([, child]) => !child.ended).map(([ref]) => stopTask(ref)));
  }
  private current(child: Child): boolean {
    const owner = this.config.currentOwner(child.parentToolRef, 'Agent');
    return !this.lifetime.signal.aborted && !child.owner.revoked.aborted && !!owner &&
      owner.nativeRef === child.owner.nativeRef && owner.revoked === child.owner.revoked;
  }
  private async emit(childRef: string, child: Child, detail: Detail): Promise<void> {
    const value = { sessionRef: this.config.sessionRef, inputId: child.owner.inputId, operationRef: child.owner.operationRef, parentToolRef: child.parentToolRef, childRef, ...detail };
    await this.deliver(value);
  }
  private async deliver(value: ClaudeSubagentObservation extends infer R ? R extends ClaudeSubagentObservation ? Omit<R, 'signal'> : never : never, revoked?: AbortSignal): Promise<void> {
    this.count++; this.bytes += Buffer.byteLength(JSON.stringify(value));
    if (this.count > this.config.maxEvents || this.bytes > this.config.maxBytes) {throw new OutputLimitError('Subagent output limit');}
    const signal = AbortSignal.any([this.lifetime.signal, ...(revoked ? [revoked] : []), AbortSignal.timeout(this.config.timeoutMs)]);
    let abort: (() => void) | undefined;
    try {
      await Promise.race([this.config.port.observe(Object.freeze({ ...structuredClone(value), signal }) as ClaudeSubagentObservation), new Promise<never>((_resolve, reject) => {
        abort = () => { reject(new Error('Subagent observation unavailable')); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) {abort();}
      })]);
    } finally { if (abort !== undefined) {signal.removeEventListener('abort', abort);} }
  }
}

function ordinaryInvocation(value: unknown): boolean {
  const input = record(value);
  return !Object.keys(input).some(key => !['prompt', 'description', 'subagent_type', 'run_in_background'].includes(key)) &&
    typeof input.prompt === 'string' && !!input.prompt && typeof input.description === 'string' && !!input.description &&
    input.subagent_type === agentType && input.run_in_background === false;
}
function sameOwner(latest: Owner | undefined, owner: Owner): boolean {
  return !!latest && latest.nativeRef === owner.nativeRef && latest.revoked === owner.revoked &&
    latest.inputId === owner.inputId && latest.operationRef === owner.operationRef;
}
function isTaskEvent(raw: Record<string, unknown>): boolean {
  return raw.type === 'system' && ['task_started', 'task_notification', 'task_progress', 'task_updated'].includes(String(raw.subtype));
}
function isNested(raw: Record<string, unknown>): boolean {
  return (raw.parent_tool_use_id !== null && raw.parent_tool_use_id !== undefined) || raw.agent_id !== undefined;
}
function nativeReference(first: unknown, second: unknown): string {
  return typeof first === 'string' ? first : typeof second === 'string' ? second : '';
}
function ordinaryStart(raw: Record<string, unknown>): boolean {
  return raw.subtype === 'task_started' && raw.task_type === 'local_agent' && raw.is_backgrounded === false &&
    raw.subagent_type === agentType && raw.parent_task_id === undefined;
}
