import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readClaudeMetadata } from '../../../../src/claude.ts';
import type { ClaudeMetadataConfig, ClaudeMetadataBoundary } from '../../../../src/claude.ts';
import type { ModelInfo, AccountInfo } from '@anthropic-ai/claude-agent-sdk';

const config = (): ClaudeMetadataConfig => ({
  cwd: '/TEST-workspace', executablePath: '/TEST-native', environment: { HOME: '/TEST-home', PATH: '/bin', CLAUDE_CONFIG_DIR: '/TEST-config' },
  configNamespace: 'custom-directory', timeoutMs: 1000,
  launch: () => { throw new Error('fixture must not launch'); },
  confirmStopped: async () => true,
});
const row: ModelInfo = { value: 'opus', resolvedModel: 'claude-opus-4-6', displayName: 'Opus', description: 'TEST', supportsFastMode: false, supportedEffortLevels: ['low', 'medium', 'high'] };

test('metadata initializes without a model input/tool/session and strips private account fields', async () => {
  let closed = 0;
  let call!: Parameters<ClaudeMetadataBoundary['query']>[0];
  const selected = config();
  const sdk: ClaudeMetadataBoundary = { query(input) {
    call = input;
    return { supportedModels: async () => [row], accountInfo: async () => ({ apiProvider: 'firstParty', apiKeySource: 'environment', email: 'TEST-private', organization: 'TEST-private' }), close: () => { closed++; } };
  } };
  const pending = readClaudeMetadata(selected, undefined, sdk);
  selected.environment.HOME = '/TEST-mutated';
  assert.equal(call.options.env?.HOME, '/TEST-home');
  assert.equal(call.options.pathToClaudeCodeExecutable, '/TEST-native');
  assert.equal(call.options.persistSession, false);
  assert.deepEqual(call.options.tools, []); assert.deepEqual(call.options.mcpServers, {});
  assert.equal(call.options.strictMcpConfig, true);
  assert.deepEqual(call.options.settings, { disableAllHooks: true });
  assert.deepEqual(call.options.settingSources, []);
  assert.equal(call.options.sessionId, undefined); assert.equal(call.options.resume, undefined);
  const input = call.prompt[Symbol.asyncIterator]().next();
  const value = await pending;
  assert.deepEqual(await input, { done: true, value: undefined });
  assert.deepEqual(value, { models: [row], account: { apiProvider: 'firstParty', apiKeySource: 'environment' } });
  assert.equal(Object.hasOwn(value, 'authenticated'), false);
  assert.equal(value.models[0]?.supportsFastMode, false);
  assert.equal(closed, 1); assert.equal(call.options.abortController?.signal.aborted, true);
});

test('cancellation and deadline close SDK without waiting for native metadata or returning late success', async () => {
  for (const mode of ['cancel', 'timeout'] as const) {
    const selected = config(); selected.timeoutMs = mode === 'timeout' ? 5 : 1000;
    const abort = new AbortController(); let closed = 0;
    let finish!: (rows: ModelInfo[]) => void;
    const held = new Promise<ModelInfo[]>(resolve => { finish = resolve; });
    const pending = readClaudeMetadata(selected, abort.signal, { query: () => ({ supportedModels: () => held, accountInfo: async () => ({}), close: () => { closed++; } }) });
    if (mode === 'cancel') { abort.abort(); }
    await assert.rejects(pending, new RegExp(`claude.metadata.${mode === 'cancel' ? 'cancelled' : 'timeout'}`, 'u'));
    assert.equal(closed, 1); finish([row]); await setImmediate(); assert.equal(closed, 1);
  }
});

test('invalid native metadata and SDK failures are bounded, closed and never disclose raw errors', async () => {
  const invalid: ModelInfo[][] = [[row, row], [{ ...row, description: 'x'.repeat(4097) }], Array.from({ length: 257 }, (_, index) => ({ ...row, value: `m${index}` }))];
  for (const rows of invalid) {
    let closed = false;
    await assert.rejects(readClaudeMetadata(config(), undefined, { query: () => ({ supportedModels: async () => rows, accountInfo: async () => ({}), close: () => { closed = true; } }) }), /claude.metadata.(invalid-response|unavailable)/u);
    assert.equal(closed, true);
  }
  let closed = false;
  await assert.rejects(readClaudeMetadata(config(), undefined, { query: () => ({ supportedModels: async () => { throw new Error('TEST-secret must not escape'); }, accountInfo: async (): Promise<AccountInfo> => ({}), close: () => { closed = true; } }) }), { message: 'claude.metadata.unavailable' });
  assert.equal(closed, true);
});

test('wrong namespace, inherited team configuration and pre-aborted reads allocate no SDK query', async () => {
  let queries = 0;
  const sdk: ClaudeMetadataBoundary = { query() { queries++; throw new Error('unexpected'); } };
  const invalid = [
    { ...config(), configNamespace: 'native-default' as const },
    { ...config(), environment: { HOME: '/TEST-home', PATH: '/bin' } },
    { ...config(), environment: { ...config().environment, CLAUDE_CODE_TEAM_NAME: 'TEST-team' } },
    { ...config(), timeoutMs: 30001 },
    Object.assign(config(), { confirmStopped: undefined }),
  ];
  for (const selected of invalid) { await assert.rejects(readClaudeMetadata(selected, undefined, sdk), /invalid-config/u); }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readClaudeMetadata(config(), abort.signal, sdk), /cancelled/u);
  assert.equal(queries, 0);
});

test('a failed SDK close cannot publish otherwise successful metadata or leak the native error', async () => {
  await assert.rejects(readClaudeMetadata(config(), undefined, { query: () => ({
    supportedModels: async () => [row], accountInfo: async () => ({}),
    close: () => { throw new Error('TEST-private cleanup details'); },
  }) }), { message: 'claude.metadata.cleanup-unconfirmed' });
});

test('metadata keeps the original root until caller cleanup settles before SDK EOF or abort', async () => {
  let rootLive = true, sdkClosed = 0, cleanupCalls = 0;
  let enter!: () => void, finish!: (clean: boolean) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const cleanup = new Promise<boolean>(resolve => { finish = resolve; });
  let input!: Promise<IteratorResult<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>>;
  const selected = config();
  selected.confirmStopped = () => {
    cleanupCalls++; assert.equal(rootLive, true, 'SDK must not retire the original root before its owner');
    enter(); return cleanup;
  };
  const pending = readClaudeMetadata(selected, undefined, { query(args) {
    input = args.prompt[Symbol.asyncIterator]().next().then(value => { rootLive = false; return value; });
    args.options.abortController?.signal.addEventListener('abort', () => { rootLive = false; });
    return { supportedModels: async () => [row], accountInfo: async () => ({}), close: () => { rootLive = false; sdkClosed++; } };
  } });
  assert.equal(await Promise.race([entered.then(() => 'owner'), pending.then(() => 'published')]), 'owner');
  assert.equal(sdkClosed, 0); assert.equal(rootLive, true);
  finish(true); await pending;
  assert.equal((await input).done, true); assert.equal(sdkClosed, 1); assert.equal(cleanupCalls, 1);
});

test('false or thrown caller cleanup still releases metadata input and closes SDK without success', async () => {
  for (const mode of ['false', 'throw'] as const) {
    const selected = config(); let closed = 0, calls = 0;
    let input!: Promise<IteratorResult<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>>;
    let aborted = false;
    selected.confirmStopped = async () => { calls++; if (mode === 'throw') { throw new Error('TEST-private custody'); } return false; };
    await assert.rejects(readClaudeMetadata(selected, undefined, { query(args) {
      input = args.prompt[Symbol.asyncIterator]().next();
      args.options.abortController?.signal.addEventListener('abort', () => { aborted = true; });
      return { supportedModels: async () => [row], accountInfo: async () => ({}), close: () => { closed++; } };
    } }), { message: 'claude.metadata.cleanup-unconfirmed' });
    assert.equal((await input).done, true); assert.equal(aborted, true); assert.equal(closed, 1); assert.equal(calls, 1);
  }
});
