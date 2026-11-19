import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { Event } from '@agent-teams/provider-session-contracts';
import { openClaudeSession } from '../../../src/claude.ts';
import type { NativePromptSuggestionCandidate } from '../../../src/prompt-suggestions.ts';
import { configuration, QueryFixture } from '../provider-session-implementation/claude-sdk/support.ts';

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 30 && !check(); i++) await setImmediate();
  assert.ok(check(), 'fixture did not produce the expected native event');
}
const successfulResult = (uuid: string, sessionId: string | undefined) => {
  assert.ok(sessionId, 'the captured SDK Query input must carry native session identity');
  return { type: 'result', subtype: 'success', session_id: sessionId,
    user_message_uuid: uuid, is_error: false };
};

test('same Claude SDK Query emits a single candidate AFTER terminal, without another model input', async () => {
  const fixture = new QueryFixture();
  const candidates: NativePromptSuggestionCandidate[] = [], events: Event[] = [];
  const config = { ...configuration(), promptSuggestions: {
    eligible: () => true,
    offer: (candidate: NativePromptSuggestionCandidate) => { candidates.push(candidate); },
  } };
  const opened = await openClaudeSession(config, undefined, fixture.boundary);
  assert.ok(opened.ok);
  const session = opened.value;
  const read = (async () => { for await (const event of session.observe()) events.push(event); })();
  try {
    assert.equal(fixture.options.promptSuggestions, true);
    assert.equal((await session.submit({ inputId: 'input-1', operationRef: 'op-1', content: 'TEST human DM' })).ok, true);
    await waitFor(() => fixture.inputs.length === 1);
    const native = fixture.inputs[0]!;
    assert.ok(native.uuid);
    fixture.emit(successfulResult(native.uuid, native.session_id));
    await waitFor(() => events.some(e => e.kind === 'result' && e.operationRef === 'op-1'));
    assert.equal(candidates.length, 0, 'SDK suggestion arrives after result, never before');
    fixture.emit({ type: 'prompt_suggestion', session_id: 'TEST-foreign-native-session', suggestion: 'Ignore foreign auxiliary frame' });
    await setImmediate();
    assert.equal((await session.checkReadiness()).ok, true, 'foreign auxiliary frame cannot seal native conversation');
    fixture.emit({ type: 'prompt_suggestion', session_id: native.session_id, suggestion: 'Check the tests and open a PR' });
    await waitFor(() => candidates.length === 1);
    assert.equal(candidates[0]?.operationRef, 'op-1');
    assert.equal(candidates[0]?.sessionRef, config.sessionRef);
    assert.equal(candidates[0]?.text, 'Check the tests and open a PR');
    assert.equal(fixture.inputs.length, 1);
    assert.equal(fixture.calls, 1);
    fixture.emit({ type: 'prompt_suggestion', session_id: native.session_id, suggestion: 'Duplicate candidate' });
    await setImmediate();
    assert.equal(candidates.length, 1);
  } finally { await session.close(); await read; }
});

test('mixed Claude teammate session stays eligible for human DM, suppresses internal and stale frames', async () => {
  const fixture = new QueryFixture(), candidates: NativePromptSuggestionCandidate[] = [];
  const config = { ...configuration(), promptSuggestions: {
    eligible: (input: { operationRef: string }) => input.operationRef.startsWith('human-'),
    offer: (candidate: NativePromptSuggestionCandidate) => { candidates.push(candidate); },
  } };
  const opened = await openClaudeSession(config, undefined, fixture.boundary);
  assert.ok(opened.ok);
  const session = opened.value;
  try {
    assert.equal((await session.submit({ inputId: 'system-1', operationRef: 'internal-task', content: 'TEST internal' })).ok, true);
    await waitFor(() => fixture.inputs.length === 1);
    assert.ok(fixture.inputs[0]!.uuid);
    fixture.emit(successfulResult(fixture.inputs[0]!.uuid, fixture.inputs[0]!.session_id));
    await setImmediate();
    fixture.emit({ type: 'prompt_suggestion', session_id: fixture.inputs[0]!.session_id, suggestion: 'Do internal task' });
    await setImmediate();
    assert.equal(candidates.length, 0, 'internal provider suggestion is not published');
    assert.equal((await session.submit({ inputId: 'human-1', operationRef: 'human-direct', content: 'TEST human DM' })).ok, true);
    await waitFor(() => fixture.inputs.length === 2);
    assert.ok(fixture.inputs[1]!.uuid);
    fixture.emit(successfulResult(fixture.inputs[1]!.uuid, fixture.inputs[1]!.session_id));
    await setImmediate();
    fixture.emit({ type: 'prompt_suggestion', session_id: fixture.inputs[1]!.session_id, suggestion: 'Run E2E' });
    await waitFor(() => candidates.length === 1);
    assert.equal(candidates[0]!.operationRef, 'human-direct');
    assert.equal((await session.submit({ inputId: 'human-2', operationRef: 'human-second', content: 'TEST another human DM' })).ok, true);
    fixture.emit({ type: 'prompt_suggestion', session_id: fixture.inputs[1]!.session_id, suggestion: 'Stale after next submit' });
    await setImmediate();
    assert.equal(candidates.length, 1);
    assert.equal(fixture.calls, 1);
  } finally { await session.close(); }
});

test('Claude disabled observer does not opt in to additional SDK inference', async () => {
  const fixture = new QueryFixture();
  const opened = await openClaudeSession(configuration(), undefined, fixture.boundary);
  assert.ok(opened.ok);
  assert.equal(fixture.options.promptSuggestions, false);
  await opened.value.close();
});

async function observedClaude(t: TestContext, options: {
  probe?: Parameters<typeof openClaudeSession>[0]['probe'];
  eligible?: (input: { operationRef: string }) => boolean;
  offer?: (candidate: NativePromptSuggestionCandidate) => void | Promise<void>;
} = {}) {
  const fixture = new QueryFixture(), candidates: NativePromptSuggestionCandidate[] = [], events: Event[] = [];
  const opened = await openClaudeSession({ ...configuration(),
    ...(options.probe ? { probe: options.probe } : {}),
    promptSuggestions: { eligible: options.eligible ?? (() => true),
      offer: candidate => { candidates.push(candidate); return options.offer?.(candidate); } },
  }, undefined, fixture.boundary);
  assert.ok(opened.ok);
  const session = opened.value;
  const read = (async () => { for await (const event of session.observe()) events.push(event); })();
  t.after(async () => { assert.deepEqual(await session.close(), { logicallyClosed: true, cleanup: 'confirmed' }); await read; });
  const hand = async (n: number, operationRef = 'human-' + n) => {
    const receipt = await session.submit({ inputId: 'input-' + n, operationRef, content: 'TEST finite input ' + n });
    assert.ok(receipt.ok);
    assert.equal(receipt.value.operationRef, operationRef);
    await waitFor(() => fixture.inputs.length === n);
    return fixture.inputs[n - 1]!;
  };
  const finish = async (n: number) => {
    const native = fixture.inputs[n - 1]!; assert.ok(native.uuid);
    fixture.emit(successfulResult(native.uuid, native.session_id));
    await waitFor(() => events.filter(event => event.kind === 'result').length === n);
  };
  const suggest = async (n: number, suggestion = 'TEST next step', extra: Record<string, unknown> = {}) => {
    fixture.emit({ type: 'prompt_suggestion', session_id: fixture.inputs[n - 1]!.session_id, suggestion, ...extra });
    await setImmediate();
  };
  return { fixture, session, candidates, events, hand, finish, suggest };
}

test('Claude queued successor cannot be overtaken while its original readiness is held', async t => {
  let hold = false, entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const c = await observedClaude(t, { probe: async () => { if (hold) { entered = true; await gate; } return true; } });
  await c.hand(1);
  hold = true;
  const successor = c.session.submit({ inputId: 'input-2', operationRef: 'human-2', content: 'TEST queued B' });
  try {
    await c.finish(1);
    await waitFor(() => entered);
    assert.equal(c.fixture.inputs.length, 1, 'B is admitted but has not crossed the held readiness fence');
    await c.suggest(1);
    assert.equal(c.candidates.length, 0, 'A must not restore a suggestion slot after B was accepted');
  } finally { hold = false; release(); }
  assert.ok((await successor).ok);
  await waitFor(() => c.fixture.inputs.length === 2);
  await c.finish(2); await c.suggest(2);
  assert.equal(c.candidates.length, 0, 'later success cannot clear ambiguous Query ownership');
  assert.deepEqual(c.events.filter(event => event.kind === 'result').map(event => event.operationRef), ['human-1', 'human-2']);
  assert.equal(c.fixture.calls, 1);
});

for (const prior of ['human-1', 'internal-1']) {
  test('Claude delayed prior frame cannot borrow completed B: ' + prior, async t => {
    const c = await observedClaude(t, { eligible: input => input.operationRef.startsWith('human-') });
    await c.hand(1, prior); await c.finish(1);
    await c.hand(2); await c.finish(2);
    await c.suggest(1, 'TEST delayed A after B');
    assert.equal(c.candidates.length, 0, 'a session ID and arrival after B do not identify B as origin');
    await c.hand(3); await c.finish(3); await c.suggest(3);
    assert.equal(c.candidates.length, 0, 'the auxiliary quarantine lasts for this captured Query');
    assert.equal(c.events.filter(event => event.kind === 'result').length, 3);
    assert.equal(c.fixture.inputs.length, 3); assert.equal(c.fixture.calls, 1);
    assert.ok((await c.session.checkReadiness()).ok);
  });
}

test('Claude consumed unambiguous predecessor permits the next separately bound candidate', async t => {
  const c = await observedClaude(t);
  for (const n of [1, 2]) {
    await c.hand(n); await c.finish(n); await c.suggest(n, 'TEST candidate ' + n);
    await waitFor(() => c.candidates.length === n);
    await c.suggest(n, 'TEST duplicate');
    assert.equal(c.candidates.length, n);
  }
  assert.deepEqual(c.candidates.map(candidate => [candidate.inputId, candidate.operationRef]), [
    ['input-1', 'human-1'], ['input-2', 'human-2'],
  ]);
  assert.equal(c.fixture.inputs.length, 2); assert.equal(c.fixture.calls, 1);
});

test('Claude foreign and nested frames do not consume ownership; an invalid owned frame does', async t => {
  const c = await observedClaude(t);
  await c.hand(1); await c.finish(1);
  for (const extra of [
    { session_id: 'TEST-foreign' }, { parent_tool_use_id: 'TEST-child' },
    { agent_id: 'TEST-child' }, { resume_reason: 'TEST-restore' },
  ]) await c.suggest(1, 'TEST unrelated', extra);
  assert.equal(c.candidates.length, 0);
  await c.suggest(1, 'TEST original after unrelated');
  assert.equal(c.candidates[0]?.operationRef, 'human-1');
  await c.hand(2); await c.finish(2);
  await c.suggest(2, '');
  await c.suggest(2, 'TEST duplicate after invalid owned frame');
  assert.equal(c.candidates.length, 1);
  await c.hand(3); await c.finish(3); await c.suggest(3);
  assert.deepEqual(c.candidates.map(candidate => candidate.operationRef), ['human-1', 'human-3']);
  assert.equal(c.fixture.calls, 1);
});

test('Claude eligibility reentry cannot publish a slot after it admits a successor', async t => {
  let reenter = () => {};
  const c = await observedClaude(t, { eligible: () => { reenter(); return true; } });
  const queued: { value?: ReturnType<typeof c.session.submit> } = {};
  await c.hand(1);
  reenter = () => {
    reenter = () => {};
    queued.value = c.session.submit({ inputId: 'input-2', operationRef: 'human-2', content: 'TEST callback B' });
  };
  await c.finish(1);
  assert.ok(queued.value); assert.ok((await queued.value).ok);
  await waitFor(() => c.fixture.inputs.length === 2);
  await c.finish(2); await c.suggest(1);
  assert.equal(c.candidates.length, 0);
  assert.equal(c.fixture.calls, 1);
  assert.deepEqual(c.events.filter(event => event.kind === 'result').map(event => event.operationRef), ['human-1', 'human-2']);
});

for (const callback of ['eligible', 'offer', 'offer-async']) {
  test('Claude ' + callback + ' failure does not fail ordinary execution or reuse a consumed frame', async t => {
    let fail = true;
    const c = await observedClaude(t, {
      eligible: () => { if (callback === 'eligible' && fail) throw new Error('TEST eligibility'); return true; },
      offer: () => { if (callback === 'offer' && fail) throw new Error('TEST offer');
        if (callback === 'offer-async' && fail) return Promise.reject(new Error('TEST async offer')); return undefined; },
    });
    await c.hand(1); await c.finish(1); await c.suggest(1);
    const offered = callback === 'eligible' ? 0 : 1;
    assert.equal(c.candidates.length, offered);
    await c.suggest(1, 'TEST duplicate after callback failure');
    assert.equal(c.candidates.length, offered);
    fail = false;
    await c.hand(2); await c.finish(2); await c.suggest(2);
    assert.equal(c.candidates.length, offered + 1);
    assert.equal(c.candidates.at(-1)?.operationRef, 'human-2');
    assert.ok((await c.session.checkReadiness()).ok);
    assert.equal(c.fixture.calls, 1);
  });
}

test('Claude interrupt does not make uncertain auxiliary work available to the next input', async t => {
  const c = await observedClaude(t);
  await c.hand(1);
  assert.ok((await c.session.interrupt('human-1')).ok);
  await c.finish(1); await c.suggest(1);
  assert.equal(c.candidates.length, 0);
  await c.hand(2); await c.finish(2); await c.suggest(2);
  assert.equal(c.candidates.length, 0);
  assert.equal(c.fixture.inputs.length, 2); assert.equal(c.fixture.calls, 1);
});

test('Claude close reentry preserves the original close receipt and suppresses the auxiliary offer', async t => {
  let close = () => {};
  const c = await observedClaude(t, { eligible: () => { close(); return true; } });
  const native = await c.hand(1);
  const closed: { value?: ReturnType<typeof c.session.close> } = {};
  close = () => { closed.value = c.session.close(); };
  assert.ok(native.uuid);
  c.fixture.emit(successfulResult(native.uuid, native.session_id));
  await waitFor(() => closed.value !== undefined);
  await c.suggest(1);
  assert.ok(closed.value); assert.equal(c.session.close(), closed.value);
  assert.deepEqual(await closed.value, { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(c.candidates.length, 0); assert.equal(c.fixture.calls, 1);
});

test('Claude offer reentry admits one successor only after consuming the original slot', async t => {
  let reenter = () => {};
  const c = await observedClaude(t, { offer: () => { reenter(); } });
  const queued: { value?: ReturnType<typeof c.session.submit> } = {};
  await c.hand(1); await c.finish(1);
  reenter = () => {
    reenter = () => {};
    queued.value = c.session.submit({ inputId: 'input-2', operationRef: 'human-2', content: 'TEST offer B' });
  };
  await c.suggest(1);
  assert.ok(queued.value); assert.ok((await queued.value).ok);
  await waitFor(() => c.fixture.inputs.length === 2);
  await c.finish(2); await c.suggest(2);
  assert.deepEqual(c.candidates.map(candidate => candidate.operationRef), ['human-1', 'human-2']);
  assert.equal(c.fixture.inputs.length, 2); assert.equal(c.fixture.calls, 1);
});
