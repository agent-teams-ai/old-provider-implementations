import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexDriverFactory } from '../../../src/codex.ts';
import type { NativePromptSuggestionCandidate } from '../../../src/prompt-suggestions.ts';
import { context, input, ref, until } from '../provider-session-implementation/codex-protocol/driver-support.ts';

async function run(t: Parameters<typeof context>[0], revision = '0.165.0') {
  const captured = await context(t), candidates: NativePromptSuggestionCandidate[] = [];
  const selected = {
    ...captured.config, protocolRevision: revision,
    initialize: { ...captured.config.initialize, capabilities: { experimentalApi: true } },
    promptSuggestions: {
      eligible: (identity: { operationRef: string }) => identity.operationRef.startsWith('op-'),
      offer: (candidate: NativePromptSuggestionCandidate) => { candidates.push(candidate); },
    },
  };
  const factory = createCodexDriverFactory({
    capabilities: captured.host.capabilities,
    resolveConfiguration: async () => selected,
    readCheckpoint: async () => undefined,
  });
  const opened = await factory.open(captured.request);
  t.after(async () => { await opened.driver.close(); });
  return { ...captured, driver: opened.driver, candidates };
}

test('Codex original subprocess sends exactly one thread/sample on bound completed root, never turn/start for sampling', async t => {
  const testCase = await run(t);
  const accepted = await testCase.driver.submit(input(1));
  assert.ok(accepted.ok);
  const nativeRef = ref(testCase.native);
  await testCase.native.command({ kind: 'finish', ...nativeRef });
  await until(() => testCase.candidates.length === 1);
  const samples = testCase.native.writes.filter(message => message.method === 'thread/sample');
  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0]?.params, {
    threadId: nativeRef.threadId, expectedTurnId: nativeRef.turnId,
    prompt: 'Predict the next message the user will send in this conversation. Reply with only that message, in under 20 words. Do not use tools. If there is no clear next step, reply with nothing.',
    effort: 'low',
  });
  assert.deepEqual(testCase.candidates.map(candidate => ({
    provider: candidate.provider, sessionRef: candidate.sessionRef,
    operationRef: candidate.operationRef, nativeTurnRef: candidate.nativeTurnRef,
  })), [{ provider: 'codex', sessionRef: 'runtime-A', operationRef: 'op-1', nativeTurnRef: nativeRef.turnId }]);
  assert.equal(testCase.native.writes.filter(message => message.method === 'turn/start').length, 1);
  assert.equal(testCase.native.writes.filter(message => message.method === 'thread/start').length, 1);
  assert.equal(testCase.native.writes.some(message => message.method === 'turn/interrupt'), false);
});

test('pinned Codex 0.162 refuses sampling while preserving normal completed turn', async t => {
  const testCase = await run(t, '0.162.0');
  await testCase.driver.submit(input(1));
  await testCase.native.command({ kind: 'finish', ...ref(testCase.native) });
  // Native completion is received asynchronously; an ordinary checkpoint is the barrier.
  await until(() => testCase.driver.checkpoint().ok);
  assert.equal(testCase.native.writes.some(message => message.method === 'thread/sample'), false);
  assert.deepEqual(testCase.candidates, []);
});

test('Codex wrong native turn and null text never become a suggestion', async t => {
  const testCase = await run(t);
  await testCase.native.command({ kind: 'sample-mode', mode: 'wrong-turn' });
  await testCase.driver.submit(input(1));
  await testCase.native.command({ kind: 'finish', ...ref(testCase.native) });
  await until(() => testCase.native.writes.some(message => message.method === 'thread/sample'));
  await until(() => testCase.driver.checkpoint().ok);
  assert.equal(testCase.candidates.length, 0);
});

test('new Codex input cancels held native sample without interrupting parent or replaying', async t => {
  const testCase = await run(t);
  await testCase.native.command({ kind: 'sample-mode', mode: 'hold' });
  await testCase.driver.submit(input(1));
  await testCase.native.command({ kind: 'finish', ...ref(testCase.native) });
  await until(() => testCase.native.writes.some(message => message.method === 'thread/sample'));
  const next = testCase.driver.submit(input(2));
  await until(() => testCase.native.writes.some(message => message.method === 'thread/sample/cancel'));
  assert.ok((await next).ok);
  assert.equal(testCase.candidates.length, 0);
  assert.equal(testCase.native.writes.filter(message => message.method === 'turn/start').length, 2);
  assert.equal(testCase.native.writes.some(message => message.method === 'turn/interrupt'), false);
  await testCase.native.command({ kind: 'finish', ...ref(testCase.native, 'turn-2') });
});
