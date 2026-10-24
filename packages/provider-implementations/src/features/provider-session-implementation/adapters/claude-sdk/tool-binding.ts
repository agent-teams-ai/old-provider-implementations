import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeToolBindingRequest = Readonly<{
  sessionRef: string;
  inputId: string;
  operationRef: string;
  nativeToolUseId: string;
  toolName: string;
  toolInput: unknown;
  signal: AbortSignal;
}>;
export type ClaudeToolBinding = Readonly<{
  matchedToolNames: readonly string[];
  prepare: (request: ClaudeToolBindingRequest) => Promise<Readonly<{ updatedInput: Record<string, unknown> }>>;
}>;
export type ForegroundToolOwner = Readonly<{
  inputId: string;
  operationRef: string;
  nativeRef: string;
  revoked: AbortSignal;
}>;
const denied = () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'Tool binding unavailable' } });

/** This callback only supplies data. It cannot grant a permission or authorize a product effect. */
export function toolBindingHook(binding: ClaudeToolBinding, sessionRef: string, nativeSession: string,
  currentOwner: (nativeToolUseId: string, toolName: string) => ForegroundToolOwner | undefined, timeoutMs: number): HookCallback {
  const names = new Set(binding.matchedToolNames);
  const prepare = binding.prepare;
  return async (input, nativeToolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse' || !names.has(input.tool_name)) { return {}; }
    if (!bound(input, nativeToolUseId, nativeSession)) { return denied(); }
    const owner = currentOwner(input.tool_use_id, input.tool_name);
    if (!owner || owner.revoked.aborted || signal.aborted) { return denied(); }
    const scopedSignal = AbortSignal.any([signal, owner.revoked, AbortSignal.timeout(timeoutMs)]);
    try {
      const captured: ClaudeToolBindingRequest = Object.freeze({ sessionRef, inputId: owner.inputId, operationRef: owner.operationRef,
        nativeToolUseId: input.tool_use_id, toolName: input.tool_name, toolInput: structuredClone(input.tool_input), signal: scopedSignal });
      const result = await abortable(prepare(captured), scopedSignal);
      const latest = currentOwner(input.tool_use_id, input.tool_name);
      if (scopedSignal.aborted || !latest || latest.revoked !== owner.revoked || latest.nativeRef !== owner.nativeRef ||
        latest.inputId !== owner.inputId || latest.operationRef !== owner.operationRef) { return denied(); }
      const updatedInput: unknown = structuredClone(result.updatedInput);
      if (!plainInput(updatedInput)) { return denied(); }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } };
    } catch { return denied(); }
  };
}
function plainInput(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function bound(input: PreToolUseHookInput, nativeToolUseId: string | undefined, nativeSession: string): boolean {
  // Native foreground tool ownership is required; prompt_id is not the SDK input UUID.
  return input.session_id === nativeSession && input.agent_id === undefined &&
    typeof nativeToolUseId === 'string' && !!nativeToolUseId && input.tool_use_id === nativeToolUseId;
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(new Error('Tool binding unavailable')); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); }
    })]);
  } finally { signal.removeEventListener('abort', onAbort); }
}
