import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Normalizer } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/normalize.ts';

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

test('native thinking snapshots and final fragments retain block identity, order and wrapper deduplication', () => {
  const normalizer = new Normalizer(1024);
  const partial = (event: unknown) => normalizer.normalize({ type: 'stream_event', event }).facts;
  partial({ type: 'message_start', message: { id: 'TEST-message' } });
  partial({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'TEST ' } });
  assert.deepEqual(partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thought' } }),
    [{ kind: 'thinking', messageRef: 'TEST-message', block: 0, text: 'TEST thought', phase: 'snapshot' }]);
  assert.deepEqual(partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' continued' } }),
    [{ kind: 'thinking', messageRef: 'TEST-message', block: 0, text: 'TEST thought continued', phase: 'snapshot' }]);
  partial({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  assert.deepEqual(partial({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'TEST output' } }),
    [{ kind: 'text', messageRef: 'TEST-message', block: 1, text: 'TEST output', phase: 'snapshot' }]);
  const wrapper = { type: 'assistant', uuid: 'TEST-wrapper', message: { id: 'TEST-message', content: [
    { type: 'thinking', thinking: 'TEST thought continued', signature: 'TEST-private-signature' },
    { type: 'text', text: 'TEST output' }, { type: 'tool_use', id: 'TEST-tool', name: 'Read', input: {} },
  ] } };
  assert.deepEqual(normalizer.normalize(wrapper).facts, [
    { kind: 'thinking', messageRef: 'TEST-message', block: 0, text: 'TEST thought continued', phase: 'complete' },
    { kind: 'text', messageRef: 'TEST-message', block: 1, text: 'TEST output', phase: 'complete' },
    { kind: 'tool', messageRef: 'TEST-message', toolRef: 'TEST-tool', name: 'Read', input: {} },
  ]);
  assert.deepEqual(normalizer.normalize(wrapper).facts, []);
  assert.deepEqual(normalizer.normalize({ ...wrapper, uuid: 'TEST-next-fragment', message: { id: 'TEST-message',
    content: [{ type: 'thinking', thinking: 'TEST next block' }] } }).facts,
    [{ kind: 'thinking', messageRef: 'TEST-message', block: 3, text: 'TEST next block', phase: 'complete' }]);
  normalizer.reset();
  assert.equal(normalizer.normalize(wrapper).facts.length, 3);
});

test('thinking ignores signatures, redaction and malformed payloads and never joins text accumulation', () => {
  const normalizer = new Normalizer(1024);
  const partial = (event: unknown) => normalizer.normalize({ type: 'stream_event', event }).facts;
  partial({ type: 'message_start', message: { id: 'TEST-message' } });
  partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'TEST answer ' } });
  for (const delta of [{ type: 'signature_delta', signature: 'TEST-private' },
    { type: 'thinking_delta', thinking: { toString() { throw new Error('coercion'); } } },
    { type: 'thinking_delta', text: 'TEST wrong field' }]) {
    assert.deepEqual(partial({ type: 'content_block_delta', index: 0, delta }), []);
  }
  assert.deepEqual(partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'TEST thought' } }),
    [{ kind: 'thinking', messageRef: 'TEST-message', block: 0, text: 'TEST thought', phase: 'snapshot' }]);
  assert.deepEqual(partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'only' } }),
    [{ kind: 'text', messageRef: 'TEST-message', block: 0, text: 'TEST answer only', phase: 'snapshot' }]);
  assert.deepEqual(normalizer.normalize({ type: 'assistant', message: { id: 'TEST-message', content: [
    { type: 'redacted_thinking', data: 'TEST-private' }, { type: 'thinking', thinking: 7 },
    { type: 'thinking', text: 'TEST wrong field' }, { type: 'text', text: 'TEST visible' },
  ] } }).facts, [{ kind: 'text', messageRef: 'TEST-message', block: 3, text: 'TEST visible', phase: 'complete' }]);
});

test('thinking accumulation obeys UTF-8 byte limits and reset retires partial state', () => {
  const normalizer = new Normalizer(4);
  const partial = (event: unknown) => normalizer.normalize({ type: 'stream_event', event }).facts;
  const delta = { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'éé' } };
  partial({ type: 'message_start', message: { id: 'TEST-message' } });
  assert.equal(partial(delta).length, 1);
  assert.throws(() => partial(delta), /output-limit/u);
  normalizer.reset();
  assert.deepEqual(partial(delta), []);
  partial({ type: 'message_start', message: { id: 'TEST-message' } });
  assert.equal(partial(delta).length, 1);
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
