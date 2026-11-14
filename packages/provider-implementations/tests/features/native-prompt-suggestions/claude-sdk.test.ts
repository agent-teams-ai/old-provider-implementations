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
const successfulResult = (uuid: string, sessionId: string) => ({
  type: 'result', subtype: 'success', session_id: sessionId,
  user_message_uuid: uuid, is_error: false,
});

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
