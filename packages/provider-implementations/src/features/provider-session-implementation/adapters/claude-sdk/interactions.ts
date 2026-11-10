import { randomUUID } from 'node:crypto';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload, InteractionReply, Reply } from '@agent-teams/provider-session-contracts';
import { fail } from './primitives.ts';
type Pending = { kind: 'question' | 'permission'; input: Record<string, unknown>; finish: (result: PermissionResult) => void };
function plainData(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') { return undefined; }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) { return undefined; }
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(entries).some((key) => typeof key !== 'string' || !('value' in entries[key]!))) { return undefined; }
  return Object.fromEntries(Object.entries(entries).map(([key, descriptor]) => [key, descriptor.value]));
}
function validatedReply(value: unknown): InteractionReply | undefined {
  try {
    const reply = plainData(value);
    if (!reply || Object.keys(reply).length !== 2) {return;}
    if (reply.kind === 'permission' && (reply.decision === 'allow' || reply.decision === 'deny')) { return { kind: 'permission', decision: reply.decision }; }
    if (reply.kind === 'question') {
      if (reply.decision === 'deny') {return { kind: 'question', decision: 'deny' };}
      const answers = plainData(reply.answers);
      if (answers && Object.values(answers).every((answer) => typeof answer === 'string')) { return { kind: 'question', answers: answers as Record<string, string> }; }
    }
  } catch { /* Untrusted JavaScript accessors or proxies are unsupported. */ }
  return undefined;
}
export class Interactions {
  private readonly pending = new Map<string, Pending>();
  private sealed = false;
  private readonly max: number;
  private readonly timeoutMs: number;
  private readonly emit: (event: EventPayload, childRef?: string, toolRef?: string) => unknown;
  constructor(max: number, timeoutMs: number, emit: (event: EventPayload, childRef?: string, toolRef?: string) => unknown) { this.max = max; this.timeoutMs = timeoutMs; this.emit = emit; }
  readonly request: CanUseTool = (tool, input, { signal, agentID, toolUseID }) => {
    if (this.sealed || signal.aborted) { return Promise.resolve({ behavior: 'deny', message: 'Interaction unavailable' }); }
    if (this.pending.size >= this.max) {
      this.emit({ kind: 'diagnostic', code: 'backpressure' });
      return Promise.resolve({ behavior: 'deny', message: 'Interaction capacity unavailable' });
    }
    input = structuredClone(input);
    const ref = randomUUID(); const kind = tool === 'AskUserQuestion' ? 'question' : 'permission';
    return new Promise<PermissionResult>((resolve) => {
      const abort = () => { finish({ behavior: 'deny', message: 'Interaction expired' }); };
      const timer = setTimeout(abort, this.timeoutMs);
      const finish = (result: PermissionResult) => {
        if (!this.pending.delete(ref)) {return;}
        clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(result);
      };
      this.pending.set(ref, { kind, input, finish }); signal.addEventListener('abort', abort, { once: true });
      const event: EventPayload = { kind: 'interaction', interactionRef: ref, request: kind === 'question' ? { kind, questions: input.questions } : { kind, tool, input } };
      try {
        const emission = this.emit(event, agentID, toolUseID);
        void Promise.resolve(emission).catch(() => { finish({ behavior: 'deny', message: 'Interaction provenance unavailable' }); });
      } catch { finish({ behavior: 'deny', message: 'Interaction provenance unavailable' }); }
    });
  };
  reply(ref: string, reply: InteractionReply): Reply<void> {
    if (this.sealed) {return fail('unavailable');}
    const pending = this.pending.get(ref);
    if (!pending) {return fail('stale');}
    const validated = validatedReply(reply);
    if (!validated || validated.kind !== pending.kind) {return fail('unsupported');}
    if (validated.decision === 'deny') {pending.finish({ behavior: 'deny', message: 'Denied by authority' });}
    else {
      const updatedInput = validated.kind === 'question' ? { ...pending.input, answers: validated.answers } : pending.input;
      pending.finish({ behavior: 'allow', updatedInput });
    }
    return { ok: true, value: undefined };
  }
  cancel(): void { for (const p of this.pending.values()) {p.finish({ behavior: 'deny', message: 'Interaction cancelled' });} }
  close(): void { this.sealed = true; this.cancel(); }
}
