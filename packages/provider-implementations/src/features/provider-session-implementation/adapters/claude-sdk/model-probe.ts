import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { nativeManagementConfiguration } from './native-management-config.ts';
import type { ClaudeNativeManagementConfig } from './native-management-config.ts';
import type { ModelInfo, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeModelProbeConfig = ClaudeNativeManagementConfig & {
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  context?: 'model-default' | 'one-million';
  /** Caller rechecks the original authority immediately before the only SDK input. */
  canSubmit: () => boolean;
};
export type ClaudeModelProbeBoundary = {
  query(input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): AsyncIterable<unknown> & Pick<Query, 'supportedModels' | 'close'>;
};
const configuration = nativeManagementConfiguration.safeExtend({
  model: z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value)),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  context: z.enum(['model-default', 'one-million']).optional(),
  canSubmit: z.custom<() => boolean>(value => typeof value === 'function'),
});
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const disallowedTypes = new Set<unknown>(['tool_progress', 'tool_use_summary', 'auth_status']);

function expectedModel(rows: ModelInfo[], selected: string, effort?: ClaudeModelProbeConfig['effort']): string {
  if (!Array.isArray(rows) || rows.length > 256) { throw new Error('claude.probe.invalid-response'); }
  const base = selected.endsWith('[1m]') ? selected.slice(0, -4) : selected;
  const matches = rows.filter(row => record(row).value === base);
  if (matches.length > 1) { throw new Error('claude.probe.invalid-response'); }
  const resolved = matches[0]?.resolvedModel ?? base;
  const capabilities = matches.length ? matches : rows.filter(row => record(row).resolvedModel === base);
  if (effort !== undefined && (!capabilities.length || capabilities.some(row => row.supportedEffortLevels?.includes(effort) !== true))) {
    throw new Error('claude.probe.invalid-response');
  }
  if (typeof resolved !== 'string' || !resolved || resolved.length > 256 || /[\0\r\n]/u.test(resolved)) { throw new Error('claude.probe.invalid-response'); }
  return resolved;
}

function assistantText(value: Record<string, unknown>, expected: string, session: string): boolean | undefined {
  const message = record(value.message);
  if (value.session_id !== session || value.parent_tool_use_id !== null || message.model !== expected || !Array.isArray(message.content)) { return undefined; }
  let text = false;
  for (const item of message.content) {
    const part = record(item);
    if (part.type === 'text' && typeof part.text === 'string') { text ||= part.text.trim().length > 0; }
    else if (part.type !== 'thinking' && part.type !== 'redacted_thinking') { return undefined; }
  }
  return text;
}
function successfulResult(value: Record<string, unknown>, expected: string, session: string, oneMillion: boolean): boolean {
  const usage = record(value.modelUsage);
  const modelUsage = record(usage[expected]);
  return value.session_id === session && value.subtype === 'success' && value.is_error === false &&
    Object.keys(usage).length === 1 && Object.hasOwn(usage, expected) &&
    typeof modelUsage.outputTokens === 'number' && Number.isSafeInteger(modelUsage.outputTokens) && modelUsage.outputTokens > 0 &&
    (!oneMillion || (typeof modelUsage.contextWindow === 'number' && modelUsage.contextWindow >= 1000000));
}

/** Requires actual main-thread text and terminal usage of exactly the selected native model. */
async function consume(native: AsyncIterable<unknown>, expected: string, session: string, oneMillion: boolean): Promise<boolean> {
  let text = false;
  let initialized = false;
  let bytes = 0;
  let events = 0;
  // Query.return() closes SDK input. Leave teardown to finally after owned cleanup.
  const iterator = native[Symbol.asyncIterator]();
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) { return false; }
    const raw = next.value;
    bytes += Buffer.byteLength(serialized(raw)); events++;
    if (bytes > 512 * 1024 || events > 256) { throw new Error('claude.probe.output-limit'); }
    const value = record(raw);
    if (value.type === 'system' && value.subtype === 'init') {
      if (value.session_id !== session || value.permissionMode !== 'dontAsk' || !Array.isArray(value.tools) || value.tools.length) { return false; }
      initialized = true;
    } else if (value.type === 'assistant') {
      const assistant = assistantText(value, expected, session);
      if (!initialized || assistant === undefined) { return false; }
      text ||= assistant;
    } else if (value.type === 'result') {
      return initialized && text && successfulResult(value, expected, session, oneMillion);
    } else if (disallowedTypes.has(value.type)) { return false; }
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
function serialized(value: unknown): string {
  const json: unknown = JSON.stringify(value);
  return typeof json === 'string' ? json : '';
}
function probeFailure(error: unknown): Error {
  const code = error instanceof Error && ['claude.probe.timeout', 'claude.probe.cancelled', 'claude.probe.invalid-response', 'claude.probe.output-limit'].includes(error.message) ? error.message : 'claude.probe.unavailable';
  return new Error(code);
}

/** One explicit no-tool input; no retries, product state, checkpoint or persisted conversation. */
export async function probeClaudeModel(selected: ClaudeModelProbeConfig, signal?: AbortSignal, sdk: ClaudeModelProbeBoundary = { query }): Promise<boolean> {
  const parsed = configuration.safeParse(selected);
  if (!parsed.success) { throw new Error('claude.probe.invalid-config'); }
  if (signal?.aborted === true) { throw new Error('claude.probe.cancelled'); }
  const captured = parsed.data;
  const abortController = new AbortController();
  const session = randomUUID();
  let inputSealed = false;
  // A timeout can seal input while native metadata or the generator is awaiting.
  const sealed = (): boolean => inputSealed;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let releaseInput!: () => void;
  const held = new Promise<void>(resolve => { releaseInput = resolve; });
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await ready;
    if (!sealed() && !abortController.signal.aborted && signal?.aborted !== true && captured.canSubmit()) {
      yield { type: 'user', uuid: randomUUID(), session_id: session, parent_tool_use_id: null,
        message: { role: 'user', content: 'Reply only OK. Do not use tools, access files or run commands.' } };
    }
    await held;
  })();
  let native: ReturnType<ClaudeModelProbeBoundary['query']> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  let result = false;
  let failed: Error | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => { reject(new Error('claude.probe.cancelled')); };
      signal?.addEventListener('abort', cancel, { once: true });
    });
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('claude.probe.timeout')); }, captured.timeoutMs); });
    native = sdk.query({ prompt, options: {
      cwd: captured.cwd, pathToClaudeCodeExecutable: captured.executablePath,
      env: { ...captured.environment }, settingSources: [...(captured.settingSources ?? [])],
      model: captured.model, sessionId: session, tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
      ...(captured.effort === undefined ? {} : { effort: captured.effort }),
      ...(captured.context === 'one-million' ? { betas: ['context-1m-2025-08-07' as const] } : {}),
      settings: { disableAllHooks: true }, persistSession: false, permissionMode: 'dontAsk',
      maxTurns: 1, abortController,
      canUseTool: async () => ({ behavior: 'deny', message: 'Tools are disabled for model connection tests.' }),
      spawnClaudeCodeProcess: request => captured.launch({ ...request, env: { ...captured.environment } }),
    } });
    const read = (async (active: NonNullable<typeof native>) => {
      const expected = expectedModel(await active.supportedModels(), captured.model, captured.effort);
      if (sealed() || signal?.aborted === true || abortController.signal.aborted || !captured.canSubmit()) { throw new Error('claude.probe.cancelled'); }
      release();
      return consume(active, expected, session, captured.context === 'one-million' || captured.model.endsWith('[1m]'));
    })(native);
    result = await Promise.race([read, timeout, cancelled]);
    if (signalAborted(signal) || !captured.canSubmit()) { result = false; }
  } catch (error) {
    failed = probeFailure(error);
  } finally {
    // Seal new input independently: SDK abort/EOF must remain behind original owner cleanup.
    inputSealed = true;
    if (timer !== undefined) { clearTimeout(timer); }
    if (cancel) { signal?.removeEventListener('abort', cancel); }
    try {
      const confirmed: unknown = await captured.confirmStopped();
      if (confirmed !== true) { failed = new Error('claude.probe.cleanup-unconfirmed'); }
    } catch { failed = new Error('claude.probe.cleanup-unconfirmed'); }
    abortController.abort(); release(); releaseInput();
    try { native?.close(); } catch { failed = new Error('claude.probe.cleanup-unconfirmed'); }
  }
  if (failed) { throw failed; }
  return result;
}
