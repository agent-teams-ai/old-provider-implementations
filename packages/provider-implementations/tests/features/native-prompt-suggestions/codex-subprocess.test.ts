import { CodexAppServerClient, CodexProtocolError } from '../../../src/codex.ts';
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

async function connectedSample(t: Parameters<typeof context>[0]) {
  const captured = await context(t);
  const client = new CodexAppServerClient({ transport: captured.native.transport,
    limits: { requestTimeoutMs: 1000 }, onEvent: () => {},
    requestApproval: async () => { throw new Error('TEST no approval expected'); },
  });
  t.after(() => { client.close(); });
  await client.initialize(captured.config.initialize);
  const thread = await client.startThread(captured.config.threadParams);
  const finish = async (n: number) => {
    const turn = thread.submitTurn({ input: [{ type: 'text', text: 'TEST ordinary turn ' + n }] });
    const accepted = await turn.accepted;
    await captured.native.command({ kind: 'finish', ...accepted });
    assert.deepEqual(await turn.completed, { ...accepted, outcome: 'completed' });
    return { threadId: accepted.threadId, expectedTurnId: accepted.turnId, prompt: 'TEST next message' };
  };
  const frames = (method: string) => captured.native.writes.filter(message => message.method === method);
  return { ...captured, client, thread, finish, frames };
}

function protocolFailure(code: string, acceptance: 'unknown' | 'not-sent') {
  return (error: unknown) => {
    assert.ok(error instanceof CodexProtocolError);
    assert.equal(error.code, code); assert.equal(error.acceptance, acceptance);
    return true;
  };
}

test('Codex actual sent sample timeout retains one exact cancel target even after late abort', async t => {
  const c = await connectedSample(t), source = await c.finish(1), abort = new AbortController();
  await c.native.command({ kind: 'sample-mode', mode: 'hold' });
  const pending = c.client.samplePromptSuggestion(source, abort.signal, () => true);
  await assert.rejects(pending, protocolFailure('codex.protocol.request-timeout', 'unknown'));
  const sample = c.frames('thread/sample')[0]; assert.ok(sample); assert.ok(sample.id);
  abort.abort();
  // The ordinary second turn is an actual same-transport queue/reply barrier, not a sleep.
  const next = await c.finish(2);
  assert.equal(next.threadId, source.threadId); assert.notEqual(next.expectedTurnId, source.expectedTurnId);
  assert.deepEqual(c.frames('thread/sample/cancel').map(frame => frame.params), [{ requestId: sample.id }]);
  assert.equal(c.frames('thread/sample').length, 1);
  assert.equal(c.frames('turn/start').length, 2); assert.equal(c.frames('thread/start').length, 1);
  assert.equal(c.frames('turn/interrupt').length, 0); assert.equal(c.client.isOpen(), true);
});

test('Codex timeout and cancel ACK cannot admit a second uncertain auxiliary sample', async t => {
  const c = await connectedSample(t), source = await c.finish(1);
  await c.native.command({ kind: 'sample-mode', mode: 'hold' });
  await assert.rejects(c.client.samplePromptSuggestion(source, new AbortController().signal, () => true),
    protocolFailure('codex.protocol.request-timeout', 'unknown'));
  const next = await c.finish(2);
  await c.native.command({ kind: 'sample-mode', mode: 'success' });
  await assert.rejects(c.client.samplePromptSuggestion(next, new AbortController().signal, () => true),
    error => { assert.ok(error instanceof CodexProtocolError); assert.equal(error.acceptance, 'not-sent'); return true; });
  assert.equal(c.frames('thread/sample').length, 1, 'unknown original work cannot be replaced by another sample');
  assert.equal(c.frames('thread/sample/cancel').length, 1);
  assert.equal(c.frames('turn/start').length, 2); assert.equal(c.frames('turn/interrupt').length, 0);
  assert.equal(c.thread.canSample(), true, 'ordinary thread readiness is not sealed by the auxiliary latch');
});

test('Codex explicit sent abort and uncertain settlement share one cancel and retain ordinary turns', async t => {
  const c = await connectedSample(t), source = await c.finish(1), abort = new AbortController();
  await c.native.command({ kind: 'sample-mode', mode: 'hold' });
  const pending = c.client.samplePromptSuggestion(source, abort.signal, () => true);
  const rejected = assert.rejects(pending, protocolFailure('codex.protocol.request-aborted', 'unknown'));
  await c.native.waitFor(event => event.event === 'wire' &&
    (event.message as { method?: string }).method === 'thread/sample');
  const sample = c.frames('thread/sample')[0]; assert.ok(sample);
  abort.abort(); await rejected; abort.abort();
  const next = await c.finish(2);
  assert.deepEqual(c.frames('thread/sample/cancel').map(frame => frame.params), [{ requestId: sample.id }]);
  await c.native.command({ kind: 'sample-mode', mode: 'success' });
  await assert.rejects(c.client.samplePromptSuggestion(next, new AbortController().signal, () => true),
    error => { assert.ok(error instanceof CodexProtocolError); assert.equal(error.acceptance, 'not-sent'); return true; });
  assert.equal(c.frames('thread/sample').length, 1);
  assert.equal(c.frames('turn/start').length, 2); assert.equal(c.frames('turn/interrupt').length, 0);
});

test('Codex known-not-sent sample refusals neither cancel native work nor poison later sampling', async t => {
  const c = await connectedSample(t), source = await c.finish(1), aborted = new AbortController();
  aborted.abort();
  await assert.rejects(c.client.samplePromptSuggestion(source, aborted.signal, () => true),
    protocolFailure('codex.sample.stale', 'not-sent'));
  let checks = 0;
  await assert.rejects(c.client.samplePromptSuggestion(source, new AbortController().signal, () => ++checks === 1),
    protocolFailure('codex.protocol.stale-write', 'not-sent'));
  assert.equal(checks, 2);
  assert.equal(c.frames('thread/sample').length, 0); assert.equal(c.frames('thread/sample/cancel').length, 0);
  const reply = await c.client.samplePromptSuggestion(source, new AbortController().signal, () => true);
  assert.deepEqual(reply, { sourceTurnId: source.expectedTurnId, responseId: 'TEST-sampled-response',
    text: 'Check the completed changes and open a PR', inputTokens: 42, cachedInputTokens: 25, outputTokens: 10 });
  assert.equal(c.frames('thread/sample').length, 1); assert.equal(c.frames('thread/sample/cancel').length, 0);
});

test('Codex a definite unsupported native reply does not create an unknown-work latch', async t => {
  const c = await connectedSample(t), source = await c.finish(1);
  await c.native.command({ kind: 'sample-mode', mode: 'unsupported' });
  await assert.rejects(c.client.samplePromptSuggestion(source, new AbortController().signal, () => true),
    protocolFailure('codex.protocol.provider-error', 'unknown'));
  await c.native.command({ kind: 'sample-mode', mode: 'success' });
  const reply = await c.client.samplePromptSuggestion(source, new AbortController().signal, () => true);
  assert.deepEqual(reply, { sourceTurnId: source.expectedTurnId, responseId: 'TEST-sampled-response',
    text: 'Check the completed changes and open a PR', inputTokens: 42, cachedInputTokens: 25, outputTokens: 10 });
  assert.equal(c.frames('thread/sample').length, 2); assert.equal(c.frames('thread/sample/cancel').length, 0);
  assert.equal(c.frames('turn/start').length, 1); assert.equal(c.frames('turn/interrupt').length, 0);
});

for (const postReply of ['throws', 'returns false']) {
  test('Codex received response stays terminal when post-reply eligibility ' + postReply, async t => {
    const c = await connectedSample(t), source = await c.finish(1), original = new Error('TEST post-reply observer');
    let checks = 0;
    await assert.rejects(c.client.samplePromptSuggestion(source, new AbortController().signal, () => {
      if (++checks === 3) { if (postReply === 'throws') throw original; return false; }
      return true;
    }), postReply === 'throws' ? (error: unknown) => error === original : protocolFailure('codex.sample.stale', 'unknown'));
    assert.equal(checks, 3);
    const reply = await c.client.samplePromptSuggestion(source, new AbortController().signal, () => true);
    assert.deepEqual(reply, { sourceTurnId: source.expectedTurnId, responseId: 'TEST-sampled-response',
      text: 'Check the completed changes and open a PR', inputTokens: 42, cachedInputTokens: 25, outputTokens: 10 });
    assert.equal(c.frames('thread/sample').length, 2); assert.equal(c.frames('thread/sample/cancel').length, 0);
    assert.equal(c.client.isOpen(), true);
  });
}

test('Codex sample close keeps the original cached physical cleanup receipt unconfirmed', async t => {
  const c = await run(t);
  await c.native.command({ kind: 'sample-mode', mode: 'hold' });
  assert.ok((await c.driver.submit(input(1))).ok);
  await c.native.command({ kind: 'finish', ...ref(c.native) });
  await c.native.waitFor(event => event.event === 'wire' &&
    (event.message as { method?: string }).method === 'thread/sample');
  const closing = c.driver.close();
  assert.equal(c.driver.close(), closing);
  assert.deepEqual(await closing, { logicallyClosed: true, cleanup: 'unknown' });
  assert.equal(c.native.writes.filter(message => message.method === 'turn/start').length, 1);
  assert.equal(c.native.writes.some(message => message.method === 'turn/interrupt'), false);
  assert.equal(c.candidates.length, 0); assert.equal((await c.driver.submit(input(2))).ok, false);
});

test('Codex transport loss preserves the original unknown error without reopening for cancellation', async t => {
  const c = await connectedSample(t), source = await c.finish(1);
  await c.native.command({ kind: 'sample-mode', mode: 'hold' });
  const pending = c.client.samplePromptSuggestion(source, new AbortController().signal, () => true);
  const rejected = assert.rejects(pending, protocolFailure('codex.protocol.transport-lost', 'unknown'));
  await c.native.waitFor(event => event.event === 'wire' &&
    (event.message as { method?: string }).method === 'thread/sample');
  await c.native.command({ kind: 'disconnect' }); await rejected;
  assert.equal(c.client.isOpen(), false);
  await assert.rejects(c.client.samplePromptSuggestion(source, new AbortController().signal, () => true),
    error => { assert.ok(error instanceof CodexProtocolError); assert.equal(error.acceptance, 'not-sent'); return true; });
  assert.equal(c.frames('thread/sample').length, 1); assert.equal(c.frames('thread/sample/cancel').length, 0);
  assert.equal(c.frames('turn/interrupt').length, 0);
});
