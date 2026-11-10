import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { nativeManagementConfiguration } from './native-management-config.ts';
import type { ClaudeNativeManagementConfig } from './native-management-config.ts';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const text = z.string().max(4096).refine(value => !value.includes('\0'));
const id = text.min(1).max(256);
const model = z.object({
  value: id, resolvedModel: id.optional(), displayName: text, description: text,
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(z.enum(['low', 'medium', 'high', 'xhigh', 'max'])).max(5).optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportsFastMode: z.boolean().optional(), supportsAutoMode: z.boolean().optional(),
});
const account = z.object({
  subscriptionType: id.optional(), tokenSource: id.optional(), apiKeySource: id.optional(),
  apiProvider: z.enum(['firstParty', 'bedrock', 'vertex', 'foundry', 'anthropicAws', 'anthropicGoogleCloud', 'mantle', 'gateway']).optional(),
});

/** Native initialization metadata only. Neither catalog nor credential source verifies access. */
export type ClaudeMetadata = { models: z.infer<typeof model>[]; account: z.infer<typeof account> };
export type ClaudeMetadataConfig = ClaudeNativeManagementConfig;
export type ClaudeMetadataBoundary = {
  query(input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Pick<Query, 'supportedModels' | 'accountInfo' | 'close'>;
};
const configuration = nativeManagementConfiguration.refine(value => value.timeoutMs <= 30000);

function failure(error: unknown): Error {
  // Native errors may contain auth/config details. Preserve only our finite public codes.
  const code = error instanceof Error && ['claude.metadata.timeout', 'claude.metadata.cancelled', 'claude.metadata.invalid-response'].includes(error.message)
    ? error.message : 'claude.metadata.unavailable';
  return new Error(code);
}

/** No input, tools, MCP, persisted conversation or automatic retry. Always closes its SDK query. */
export async function readClaudeMetadata(
  selected: ClaudeMetadataConfig,
  signal?: AbortSignal,
  sdk: ClaudeMetadataBoundary = { query },
): Promise<ClaudeMetadata> {
  const parsed = configuration.safeParse(selected);
  if (!parsed.success) { throw new Error('claude.metadata.invalid-config'); }
  const captured = parsed.data;
  if (signal?.aborted === true) { throw new Error('claude.metadata.cancelled'); }
  const environment = { ...captured.environment };
  const launch = captured.launch;
  const abortController = new AbortController();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // Ending stdin before initialize can terminate the native control protocol.
  const prompt: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({
    next: async () => { await held; return { done: true, value: undefined }; },
  }) };
  let native: ReturnType<ClaudeMetadataBoundary['query']> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  let result: ClaudeMetadata | undefined;
  let failed: Error | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => { reject(new Error('claude.metadata.cancelled')); };
      signal?.addEventListener('abort', cancel, { once: true });
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('claude.metadata.timeout')); }, captured.timeoutMs);
    });
    native = sdk.query({ prompt, options: {
      cwd: captured.cwd, pathToClaudeCodeExecutable: captured.executablePath,
      env: environment, settingSources: [...(captured.settingSources ?? [])],
      tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
      // Status initialization must not execute hooks inherited from selected settings.
      settings: { disableAllHooks: true },
      persistSession: false, permissionMode: 'dontAsk', abortController,
      spawnClaudeCodeProcess: request => launch({ ...request, env: { ...environment } }),
    } });
    const read = Promise.all([native.supportedModels(), native.accountInfo()]).then(([models, info]) => {
      const snapshot = { models: z.array(model).max(256).parse(models), account: account.parse(info) };
      if (new Set(snapshot.models.map(row => row.value)).size !== snapshot.models.length ||
        Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024) { throw new Error('claude.metadata.invalid-response'); }
      return snapshot;
    });
    result = await Promise.race([read, timeout, cancelled]);
  } catch (error) {
    failed = failure(error);
  } finally {
    if (timer !== undefined) { clearTimeout(timer); }
    if (cancel) { signal?.removeEventListener('abort', cancel); }
    // The caller must settle its owned group while the original root is still live.
    try {
      const confirmed: unknown = await captured.confirmStopped();
      if (confirmed !== true) { failed = new Error('claude.metadata.cleanup-unconfirmed'); }
    } catch { failed = new Error('claude.metadata.cleanup-unconfirmed'); }
    release();
    abortController.abort();
    try { native?.close(); } catch { failed = new Error('claude.metadata.cleanup-unconfirmed'); }
  }
  if (failed) { throw failed; }
  if (!result) { throw new Error('claude.metadata.unavailable'); }
  return result;
}
