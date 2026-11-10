import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { context, ref } from './driver-support.ts';
import { artifact, attachedInput, attachmentPort } from '../provider-session-io/attachment-support.ts';

test('actual app-server turn/start carries ordered native localImage parts without prompt-path substitutes', async t => {
  const f = await context(t), a = artifact('TEST-a'), b = artifact('TEST-b', 'image/webp');
  Object.assign(f.config, { attachments: attachmentPort('TEST-model', [a, b]) });
  const { driver } = await f.factory.open(f.request); t.after(() => driver.close());
  const refs = [a.reference, b.reference]; const submission = driver.submit(attachedInput(refs)); refs.reverse();
  assert.equal((await submission).ok, true);
  assert.deepEqual((f.native.writes.find(frame => frame.method === 'turn/start')!.params as { input: unknown }).input,
    [{ type: 'text', text: 'TEST text', text_elements: [] }, { type: 'localImage', path: '/TEST-unused/attachments/TEST-a' }, { type: 'localImage', path: '/TEST-unused/attachments/TEST-b' }]);
  await f.native.command({ kind: 'finish', ...ref(f.native) });
});

test('Codex GIF/document and missing owned native path fail known not sent at actual protocol boundary', async t => {
  const f = await context(t), image = artifact(), gif = artifact('TEST-gif', 'image/gif'), pdf = artifact('TEST-pdf', 'application/pdf');
  const port = attachmentPort('TEST-model', [image, gif, pdf]);
  Object.assign(f.config, { attachments: { ...port, resolve: async (binding: Parameters<typeof port.resolve>[0]) => ({ binding, bytes: image.bytes }) } });
  const { driver } = await f.factory.open(f.request); t.after(() => driver.close());
  for (const [index, item] of [gif, pdf, image].entries()) {
    const result = await driver.submit(attachedInput([item.reference], index));
    assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.delivery, 'known-not-sent'); }
  }
  assert.equal(f.native.writes.some(frame => frame.method === 'turn/start'), false);
});

test('Codex resolver response after close cannot perform native turn/start', async t => {
  const f = await context(t), image = artifact(), port = attachmentPort('TEST-model', [image]);
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  Object.assign(f.config, { attachments: { ...port, resolve: async (binding: Parameters<typeof port.resolve>[0]) => { await hold; return { binding, bytes: image.bytes, nativePath: '/TEST-unused/image.png' }; } } });
  const { driver } = await f.factory.open(f.request);
  const submission = driver.submit(attachedInput([image.reference])); await setImmediate(); await driver.close(); release();
  const result = await submission; assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.delivery, 'known-not-sent'); }
  await setImmediate(); assert.equal(f.native.writes.some(frame => frame.method === 'turn/start'), false);
});
