import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Normalizer, OutputLimitError } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/normalize.ts';

test('malformed native message identity cannot invoke coercion or inherit the previous stream', () => {
  const normalizer = new Normalizer(1024); let coercions = 0;
  normalizer.normalize({ type: 'stream_event', event: { type: 'message_start', message: { id: 'previous' } } });
  const identity = { toString: () => { coercions++; throw new Error('untrusted coercion'); } };
  assert.deepEqual(normalizer.normalize({ type: 'stream_event',
    event: { type: 'message_start', message: { id: identity } },
  }), { facts: [] });
  assert.deepEqual(normalizer.normalize({ type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'unattributed' } },
  }), { facts: [] });
  assert.equal(coercions, 0);
});


test('actual SDK compact_boundary becomes a neutral stable observation and survives turn reset', () => {
  const normalizer = new Normalizer(1024);
  const compact = { type: 'system', subtype: 'compact_boundary', uuid: 'TEST-boundary', session_id: 'TEST-native',
    compact_metadata: { trigger: 'auto', pre_tokens: 190000, preserved_messages: [{ secret: 'not-neutral' }] } };
  const first = normalizer.normalize(compact);
  assert.equal(first.facts[0]?.kind, 'compaction');
  assert.deepEqual(Object.keys(first.facts[0] ?? {}).toSorted(), ['kind', 'reason', 'sourceRef']);
  assert.equal((first.facts[0] as { reason: string }).reason, 'automatic');
  assert.match((first.facts[0] as { sourceRef: string }).sourceRef, /^[a-f0-9]{64}$/u);
  assert.deepEqual(new Normalizer(1024).normalize(compact), first);
  assert.deepEqual(normalizer.normalize(compact), { facts: [] });
  normalizer.reset();
  assert.deepEqual(normalizer.normalize({ ...compact, compact_metadata: { trigger: 'manual' } }), { facts: [] });
  assert.equal((normalizer.normalize({ ...compact, uuid: 'second', compact_metadata: { trigger: 'manual' } }).facts[0] as { reason: string }).reason, 'manual');
  assert.equal((normalizer.normalize({ ...compact, uuid: 'third', compact_metadata: {} }).facts[0] as { reason: string }).reason, 'unknown');
  assert.notDeepEqual(normalizer.normalize({ ...compact, session_id: 'other' }), first);
});

test('compaction rejects malformed identity without coercion and bounds persistent tombstones', () => {
  const normalizer = new Normalizer(64);
  const compact = { type: 'system', subtype: 'compact_boundary', uuid: 'one', session_id: 'TEST-native' };
  assert.deepEqual(normalizer.normalize({ ...compact, uuid: { toString() { throw new Error('coercion'); } } }), { facts: [{ kind: 'diagnostic', code: 'unknown-event' }] });
  normalizer.normalize(compact); normalizer.reset();
  assert.throws(() => normalizer.normalize({ ...compact, uuid: 'two' }), /output-limit/u);
});

test('thinking deltas and final blocks preserve native identities without exposing signatures or redaction', () => {
  const normalizer = new Normalizer(1024);
  const stream = (event: Record<string, unknown>) => normalizer.normalize({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'TEST-message' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'TEST ' } });
  assert.deepEqual(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } }), {
    facts: [{ kind: 'thinking', messageRef: 'TEST-message', block: 0, text: 'TEST reasoning', phase: 'snapshot' }],
  });
  assert.deepEqual(stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'TEST-private-signature' } }), { facts: [] });
  assert.deepEqual(stream({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'TEST-private-redaction' } }), { facts: [] });
  stream({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } });
  assert.deepEqual(stream({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'TEST answer' } }), {
    facts: [{ kind: 'text', messageRef: 'TEST-message', block: 2, text: 'TEST answer', phase: 'snapshot' }],
  });
  const complete = { type: 'assistant', uuid: 'TEST-wrapper', message: { id: 'TEST-message', content: [
    { type: 'thinking', thinking: 'TEST reasoning', signature: 'TEST-private-signature' },
    { type: 'redacted_thinking', data: 'TEST-private-redaction' },
    { type: 'text', text: 'TEST answer' },
    { type: 'tool_use', id: 'TEST-tool', name: 'Read', input: { path: 'TEST' } },
  ] } };
  assert.deepEqual(normalizer.normalize(complete), { facts: [
    { kind: 'thinking', messageRef: 'TEST-message', block: 0, text: 'TEST reasoning', phase: 'complete' },
    { kind: 'text', messageRef: 'TEST-message', block: 2, text: 'TEST answer', phase: 'complete' },
    { kind: 'tool', messageRef: 'TEST-message', toolRef: 'TEST-tool', name: 'Read', input: { path: 'TEST' } },
  ] });
  assert.deepEqual(normalizer.normalize(complete), { facts: [] });
  assert.deepEqual(normalizer.normalize({ type: 'assistant', uuid: 'TEST-other-wrapper', message: {
    id: 'TEST-other-message', content: [{ type: 'thinking', thinking: 'TEST reasoning' }],
  } }), { facts: [{ kind: 'thinking', messageRef: 'TEST-other-message', block: 0, text: 'TEST reasoning', phase: 'complete' }] });
});

test('thinking snapshots retain the existing UTF-8 byte limit and reset independently of text', () => {
  const normalizer = new Normalizer(4);
  const stream = (event: Record<string, unknown>) => normalizer.normalize({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'TEST-bound' } });
  assert.deepEqual(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ЯЯ' } }), {
    facts: [{ kind: 'thinking', messageRef: 'TEST-bound', block: 0, text: 'ЯЯ', phase: 'snapshot' }],
  });
  assert.throws(() => stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Я' } }), OutputLimitError);
  normalizer.reset();
  stream({ type: 'message_start', message: { id: 'TEST-bound' } });
  assert.deepEqual(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Я' } }), {
    facts: [{ kind: 'thinking', messageRef: 'TEST-bound', block: 0, text: 'Я', phase: 'snapshot' }],
  });
  assert.deepEqual(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'text' } }), {
    facts: [{ kind: 'text', messageRef: 'TEST-bound', block: 0, text: 'text', phase: 'snapshot' }],
  });
});
