import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { bounded, deferred, EventFeed } from '../../../../src/features/provider-session-implementation/adapters/provider-session-io/io.ts';

test('single-consumer feed preserves admitted facts and one reserved terminal when capacity is full', async () => {
  const feed = new EventFeed<{ value: string }>(1, 100);
  assert.equal(feed.push({ value: 'first' }), true);
  assert.equal(feed.push({ value: 'overflow' }), false);
  feed.finishWith({ value: 'typed-failure' }); feed.finishWith({ value: 'cannot-replace-first-terminal' });
  assert.equal(feed.push({ value: 'after-close' }), false);
  const values = []; for await (const value of feed) {values.push(value);}
  assert.deepEqual(values, [{ value: 'first' }, { value: 'typed-failure' }]);
  await assert.rejects(feed[Symbol.asyncIterator]().next(), /single observer/u);
});
test('feed byte budget counts UTF-8 encoded JSON and draining releases ordinary capacity', async () => {
  const value = { text: '🧪' }; const bytes = Buffer.byteLength(JSON.stringify(value));
  const feed = new EventFeed<typeof value>(2, bytes);
  assert.equal(feed.push(value), true); assert.equal(feed.push(value), false);
  const iterator = feed[Symbol.asyncIterator](); assert.deepEqual(await iterator.next(), { done: false, value });
  assert.equal(feed.push(value), true); feed.end();
  assert.deepEqual(await iterator.next(), { done: false, value }); assert.equal((await iterator.next()).done, true);
});
test('deadline bounds observation without cancelling owned work and late completion cannot change its rejection', async () => {
  const work = deferred<string>();
  await assert.rejects(bounded(work.promise, 5), /deadline/u);
  work.resolve('late-owned-result'); assert.equal(await work.promise, 'late-owned-result');
  assert.equal(await bounded(Promise.resolve('ready'), 50), 'ready');
  await assert.rejects(bounded(Promise.reject(new Error('owned-error')), 50), /owned-error/u);
  const wake = deferred<string>(); wake.resolve('first'); wake.resolve('second');
  assert.equal(await wake.promise, 'first'); await wait(1);
});
