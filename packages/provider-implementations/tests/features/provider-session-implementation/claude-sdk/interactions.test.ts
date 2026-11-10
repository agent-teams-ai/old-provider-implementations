import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayload } from '@agent-teams/provider-session-contracts';
import { Interactions } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/interactions.ts';
function fixture() {
  const events: EventPayload[] = [];
  const interactions = new Interactions(4, 1000, event => events.push(event));
  const request = (tool = 'AskUserQuestion') => {
    const signal = new AbortController();
    const input = { questions: [{ question: 'TEST question', options: [{ label: 'TEST answer' }] }], marker: 'TEST original input' };
    const result = interactions.request(tool, input, { signal: signal.signal, toolUseID: 'TEST-tool', requestId: 'TEST-request' });
    const event = events.at(-1); assert(event?.kind === 'interaction');
    return { signal, result, input, ref: event.interactionRef };
  };
  return { interactions, request };
}

test('question denial completes actual canUseTool callback as deny once without answers or interrupt', async () => {
  const f = fixture(), question = f.request();
  assert.deepEqual(f.interactions.reply(question.ref, { kind: 'question', decision: 'deny' }), { ok: true, value: undefined });
  assert.deepEqual(await question.result, { behavior: 'deny', message: 'Denied by authority' });
  assert.deepEqual(f.interactions.reply(question.ref, { kind: 'question', decision: 'deny' }), { ok: false, code: 'stale' });
  f.interactions.close();
});

test('question answers retain original input and reject ambiguous/unknown/getter replies before callback settlement', async () => {
  const f = fixture(), question = f.request();
  for (const reply of [
    { kind: 'question', decision: 'deny', answers: {} }, { kind: 'question', decision: 'allow' },
    { kind: 'question', decision: 'deny', extra: true }, { kind: 'question', answers: {}, extra: true },
    { kind: 'permission', decision: 'deny' }, { kind: 'question', answers: { question: 1 } },
    { kind: 'question', get decision() {throw new Error('must not invoke getter');} },
  ]) {assert.deepEqual(f.interactions.reply(question.ref, reply as never), { ok: false, code: 'unsupported' });}
  assert.deepEqual(f.interactions.reply(question.ref, { kind: 'question', answers: { 'TEST question': 'TEST answer' } }), { ok: true, value: undefined });
  assert.deepEqual(await question.result, { behavior: 'allow', updatedInput: { ...question.input, answers: { 'TEST question': 'TEST answer' } } });
  f.interactions.close();
});

test('denying question A cannot deny permission B; abort makes late question denial stale', async () => {
  const f = fixture(), question = f.request(), permission = f.request('Bash');
  assert.deepEqual(f.interactions.reply(permission.ref, { kind: 'question', decision: 'deny' }), { ok: false, code: 'unsupported' });
  question.signal.abort(); assert.deepEqual(await question.result, { behavior: 'deny', message: 'Interaction expired' });
  assert.deepEqual(f.interactions.reply(question.ref, { kind: 'question', decision: 'deny' }), { ok: false, code: 'stale' });
  assert.deepEqual(f.interactions.reply(permission.ref, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined });
  assert.deepEqual(await permission.result, { behavior: 'allow', updatedInput: permission.input });
  f.interactions.close();
});
