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
