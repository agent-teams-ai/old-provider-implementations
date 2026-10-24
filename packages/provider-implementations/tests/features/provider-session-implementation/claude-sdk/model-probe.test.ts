import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { probeClaudeModel } from '../../../../src/claude.ts';
import type { ClaudeModelProbeBoundary, ClaudeModelProbeConfig } from '../../../../src/claude.ts';
import type { ModelInfo, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

function deferred<T>() {
  let complete!: (value: T) => void;
  return { promise: new Promise<T>(resolve => { complete = resolve; }), resolve: (value: T) => complete(value) };
}
const row: ModelInfo = { value: 'opus', resolvedModel: 'TEST-wire-model', displayName: 'TEST', description: 'TEST' };
const config = (): ClaudeModelProbeConfig => ({ cwd: '/TEST-workspace', executablePath: '/TEST-native',
  environment: { HOME: '/TEST-home', PATH: '/bin', CLAUDE_CONFIG_DIR: '/TEST-config' }, configNamespace: 'custom-directory',
  model: 'opus', timeoutMs: 1000, canSubmit: () => true, launch: () => { throw new Error('No native launch in controlled fixture'); }, confirmStopped: async () => true });
function frames(session: string): Record<string, unknown>[] {
  return [
    { type: 'system', subtype: 'init', session_id: session, permissionMode: 'dontAsk', tools: [] },
    { type: 'assistant', session_id: session, parent_tool_use_id: null, message: { model: 'TEST-wire-model', content: [{ type: 'text', text: 'OK' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: session, modelUsage: { 'TEST-wire-model': { outputTokens: 1, contextWindow: 200000 } } },
  ];
}
class Fixture {
  options!: Options;
  closed = 0;
  inputs: SDKUserMessage[] = [];
  models = Promise.resolve([row]);
  promptPermit: Promise<void> | undefined;
  messages = frames;
  failClose = false;
  onInputEof = () => {};
  onIteratorClose = () => {};
  private readonly input = deferred<void>();
  readonly boundary: ClaudeModelProbeBoundary = { query: args => {
    this.options = args.options;
    void (async () => { if (this.promptPermit) { await this.promptPermit; } for await (const input of args.prompt) { this.inputs.push(input); this.input.resolve(); } this.onInputEof(); })();
    return { supportedModels: () => this.models, close: () => { this.closed++; this.input.resolve(); if (this.failClose) { throw new Error('TEST-private close'); } },
      [Symbol.asyncIterator]: () => this.observe() };
  } };
  private async *observe() {
    await this.input.promise;
    try { for (const message of this.messages(String(this.options.sessionId))) { yield message; } }
    finally { this.onIteratorClose(); }
  }
}

test('one explicit SDK input uses captured model/options and needs real matching terminal model usage', async () => {
  const f = new Fixture(); const selected = config();
  const result = probeClaudeModel(selected, undefined, f.boundary);
  selected.environment.HOME = '/TEST-mutated';
  assert.equal(await result, true);
  assert.equal(f.inputs.length, 1); assert.equal(f.closed, 1);
  assert.equal(f.options.env?.HOME, '/TEST-home'); assert.equal(f.options.model, 'opus');
  assert.deepEqual(f.options.tools, []); assert.deepEqual(f.options.mcpServers, {});
  assert.deepEqual(f.options.settings, { disableAllHooks: true }); assert.equal(f.options.persistSession, false);
  assert.equal(f.options.maxTurns, 1); assert.equal(f.options.permissionMode, 'dontAsk');
  assert.equal(f.inputs[0]?.session_id, f.options.sessionId);
});

test('catalog metadata alone, wrong model, tool use, child output, failed result and missing usage cannot verify access', async () => {
  const invalid = [
    (session: string) => frames(session).slice(0, 1),
    (session: string) => { const rows = frames(session); rows[1] = { ...rows[1], message: { model: 'TEST-other-model', content: [{ type: 'text', text: 'OK' }] } }; return rows; },
    (session: string) => { const rows = frames(session); rows[1] = { ...rows[1], message: { model: 'TEST-wire-model', content: [{ type: 'tool_use', name: 'Bash' }] } }; return rows; },
    (session: string) => { const rows = frames(session); rows[1] = { ...rows[1], parent_tool_use_id: 'TEST-child' }; return rows; },
    (session: string) => { const rows = frames(session); rows[2] = { ...rows[2], is_error: true }; return rows; },
    (session: string) => { const rows = frames(session); rows[2] = { ...rows[2], modelUsage: {} }; return rows; },
  ];
  for (const messages of invalid) {
    const f = new Fixture(); f.messages = messages;
    assert.equal(await probeClaudeModel(config(), undefined, f.boundary), false);
    assert.equal(f.inputs.length, 1); assert.equal(f.closed, 1);
  }
});

test('revoked authority and cancellation during metadata do not hand a model input to SDK', async () => {
  for (const action of ['revoke', 'cancel'] as const) {
    const f = new Fixture(); const selected = config(); const models = deferred<ModelInfo[]>();
    f.models = models.promise;
    let current = true; selected.canSubmit = () => current;
    const abort = new AbortController();
    const pending = probeClaudeModel(selected, abort.signal, f.boundary);
    if (action === 'revoke') { current = false; models.resolve([row]); } else { abort.abort(); }
    await assert.rejects(pending, /claude.probe.cancelled/u);
    models.resolve([row]); await setImmediate();
    assert.equal(f.inputs.length, 0); assert.equal(f.closed, 1);
  }
});

test('deadline seals a late input and failed SDK cleanup cannot publish success', async () => {
  const f = new Fixture(); const models = deferred<ModelInfo[]>(); f.models = models.promise;
  await assert.rejects(probeClaudeModel({ ...config(), timeoutMs: 5 }, undefined, f.boundary), /claude.probe.timeout/u);
  models.resolve([row]); await setImmediate(); assert.equal(f.inputs.length, 0); assert.equal(f.closed, 1);
  const closing = new Fixture(); closing.failClose = true;
  await assert.rejects(probeClaudeModel(config(), undefined, closing.boundary), { message: 'claude.probe.cleanup-unconfirmed' });
});

test('explicit one-million suffix is preserved and requires matching native context evidence', async () => {
  const small = new Fixture();
  assert.equal(await probeClaudeModel({ ...config(), model: 'opus[1m]' }, undefined, small.boundary), false);
  const large = new Fixture(); large.messages = session => { const rows = frames(session); rows[2] = { ...rows[2], modelUsage: { 'TEST-wire-model': { outputTokens: 1, contextWindow: 1000000 } } }; return rows; };
  assert.equal(await probeClaudeModel({ ...config(), model: 'opus[1m]' }, undefined, large.boundary), true);
  assert.equal(large.options.model, 'opus[1m]');
  const beta = new Fixture(); beta.messages = large.messages;
  assert.equal(await probeClaudeModel({ ...config(), context: 'one-million' }, undefined, beta.boundary), true);
  assert.deepEqual(beta.options.betas, ['context-1m-2025-08-07']);
  assert.equal(beta.options.model, 'opus');
});

test('invalid namespace or model rejects before SDK construction', async () => {
  let calls = 0;
  const sdk: ClaudeModelProbeBoundary = { query: () => { calls++; throw new Error('Unexpected query'); } };
  for (const selected of [{ ...config(), model: 'TEST\nmodel' }, { ...config(), environment: { HOME: '/TEST-home', PATH: '/bin' } }, Object.assign(config(), { confirmStopped: undefined })]) {
    await assert.rejects(probeClaudeModel(selected, undefined, sdk), /invalid-config/u);
  }
  assert.equal(calls, 0);
});

test('explicit effort reaches SDK only with matching native model capability; unsupported effort sends no input', async () => {
  const accepted = new Fixture();
  accepted.models = Promise.resolve([{ ...row, supportedEffortLevels: ['low', 'medium', 'high'] }]);
  assert.equal(await probeClaudeModel({ ...config(), effort: 'medium' }, undefined, accepted.boundary), true);
  assert.equal(accepted.options.effort, 'medium');
  const denied = new Fixture(); denied.models = accepted.models;
  await assert.rejects(probeClaudeModel({ ...config(), effort: 'max' }, undefined, denied.boundary), /invalid-response/u);
  await setImmediate();
  assert.equal(denied.inputs.length, 0); assert.equal(denied.closed, 1);
});

test('terminal probe evidence cannot retire the root through input EOF or iterator return before its owner', async () => {
  const f = new Fixture(); const selected = config();
  let rootLive = true, cleanupCalls = 0;
  f.onInputEof = () => { rootLive = false; };
  f.onIteratorClose = () => { rootLive = false; };
  let enter!: () => void, finish!: (clean: boolean) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const cleanup = new Promise<boolean>(resolve => { finish = resolve; });
  selected.confirmStopped = () => {
    cleanupCalls++; assert.equal(rootLive, true, 'EOF or Query.return retired the root before owned cleanup');
    assert.equal(f.closed, 0); assert.equal(f.options.abortController?.signal.aborted, false);
    enter(); return cleanup;
  };
  const pending = probeClaudeModel(selected, undefined, f.boundary);
  assert.equal(await Promise.race([entered.then(() => 'owner'), pending.then(() => 'published')]), 'owner');
  assert.equal(rootLive, true); assert.equal(f.inputs.length, 1);
  finish(true); assert.equal(await pending, true); await setImmediate();
  assert.equal(cleanupCalls, 1); assert.equal(f.closed, 1); assert.equal(rootLive, false);
});

test('false or thrown caller cleanup releases the one probe input and closes SDK without success', async () => {
  for (const mode of ['false', 'throw'] as const) {
    const f = new Fixture(); const selected = config(); let inputEnded = false, calls = 0;
    f.onInputEof = () => { inputEnded = true; };
    selected.confirmStopped = async () => { calls++; if (mode === 'throw') { throw new Error('TEST-private custody'); } return false; };
    await assert.rejects(probeClaudeModel(selected, undefined, f.boundary), { message: 'claude.probe.cleanup-unconfirmed' });
    await setImmediate(); assert.equal(inputEnded, true); assert.equal(f.closed, 1); assert.equal(calls, 1);
    assert.equal(f.inputs.length, 1); assert.equal(f.options.abortController?.signal.aborted, true);
  }
});


test('deadline seals input admission while original owner cleanup is still pending', { timeout: 2000 }, async t => {
  for (const mode of ['late-models', 'late-prompt-pull'] as const) {
    await t.test(mode, async () => {
      const f = new Fixture(), models = deferred<ModelInfo[]>(), promptPermit = deferred<void>();
      const entered = deferred<void>(), cleanup = deferred<boolean>();
      if (mode === 'late-models') { f.models = models.promise; }
      else { f.promptPermit = promptPermit.promise; }
      const selected = { ...config(), timeoutMs: 5, confirmStopped: () => { entered.resolve(); return cleanup.promise; } };
      const pending = probeClaudeModel(selected, undefined, f.boundary);
      const rejected = assert.rejects(pending, { message: 'claude.probe.timeout' });
      await entered.promise;
      try {
        // Exercise late metadata AND an already-released prompt not yet pulled by the SDK.
        models.resolve([row]); promptPermit.resolve(); await setImmediate();
        assert.equal(f.inputs.length, 0, 'timeout cannot dispatch the one model input during owner cleanup');
        assert.equal(f.closed, 0, 'SDK close stays after original owner cleanup');
        assert.equal(f.options.abortController?.signal.aborted, false, 'admission seal must not abort/reap the original root');
      } finally { cleanup.resolve(true); await rejected; }
      await setImmediate();
      assert.equal(f.inputs.length, 0); assert.equal(f.closed, 1);
      assert.equal(f.options.abortController?.signal.aborted, true);
    });
  }
});
