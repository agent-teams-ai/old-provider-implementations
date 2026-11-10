import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { createClaudeDriverFactory } from '../../../../src/claude.ts';
import { artifact, attachedInput, attachmentPort } from '../provider-session-io/attachment-support.ts';
import { configuration, QueryFixture, request } from './support.ts';

test('actual SDK user message preserves ordered native document/image parts and text default', async () => {
  const sdk = new QueryFixture(), c = configuration();
  const items = [artifact('TEST-notes', 'text/markdown', 'TEST instructions'), artifact('TEST-image', 'image/gif'), artifact('TEST-pdf', 'application/pdf')];
  c.attachments = attachmentPort(c.model, items);
  const { driver } = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => {} }, sdk.boundary).open(request);
  try {
    const refs = items.map(item => ({ ...item.reference })); const submit = driver.submit(attachedInput(refs)); refs.reverse();
    assert.equal((await submit).ok, true); await setImmediate();
    const content = sdk.inputs[0]!.message.content;
    assert.ok(Array.isArray(content)); assert.deepEqual(content.map(part => part.type), ['document', 'image', 'document', 'text']);
    assert.deepEqual(content[0], { type: 'document', title: 'TEST-notes', source: { type: 'text', media_type: 'text/plain', data: 'TEST instructions' } });
    assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: items[1]!.bytes.toString('base64') } });
    assert.deepEqual(content[2], { type: 'document', title: 'TEST-pdf', source: { type: 'base64', media_type: 'application/pdf', data: items[2]!.bytes.toString('base64') } });
  } finally { await driver.close(); }
});

test('unsupported missing corrupt and foreign-binding attachments cannot enter SDK iterable; next text remains usable', async () => {
  for (const mode of ['unsupported', 'missing', 'digest', 'binding']) {
    const sdk = new QueryFixture(), c = configuration(), item = artifact();
    const port = attachmentPort(c.model, [item]);
    c.attachments = { ...port, mimeTypes: mode === 'unsupported' ? [] : port.mimeTypes, resolve: async binding => mode === 'missing' ? undefined : ({ binding: mode === 'binding' ? { ...binding, sessionRef: 'other' } : binding, bytes: mode === 'digest' ? Buffer.alloc(item.bytes.length, 0) : item.bytes }) };
    const { driver } = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => {} }, sdk.boundary).open(request);
    try {
      const reply = await driver.submit(attachedInput([item.reference])); assert.equal(reply.ok, false); if (!reply.ok) { assert.equal(reply.delivery, 'known-not-sent'); }
      assert.equal(sdk.inputs.length, 0);
      assert.equal((await driver.submit({ inputId: 'text', operationRef: 'text', content: 'legacy' })).ok, true); await setImmediate();
      assert.equal(sdk.inputs[0]?.message.content, 'legacy');
    } finally { await driver.close(); }
  }
});

test('close while resolver is held seals handoff and discards late bytes', async () => {
  const sdk = new QueryFixture(), c = configuration(), item = artifact(), port = attachmentPort(c.model, [item]);
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  c.attachments = { ...port, resolve: async binding => { await hold; return { binding, bytes: item.bytes }; } };
  const { driver } = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => {} }, sdk.boundary).open(request);
  const submission = driver.submit(attachedInput([item.reference])); await setImmediate();
  await driver.close(); release();
  const result = await submission; assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.delivery, 'known-not-sent'); }
  await setImmediate(); assert.equal(sdk.inputs.length, 0);
});

test('attachment policy revision and selected model enter checkpoint compatibility', async () => {
  const sdk = new QueryFixture(), c = configuration(), item = artifact(); c.attachments = attachmentPort(c.model, [item]);
  let checkpoint: unknown;
  const host = { capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => checkpoint };
  const { driver } = await createClaudeDriverFactory(host, sdk.boundary).open(request);
  const cp = driver.checkpoint(); assert.ok(cp.ok); checkpoint = cp.value; await driver.close();
  c.attachments = { ...c.attachments, revision: 'TEST-new-policy' };
  await assert.rejects(createClaudeDriverFactory(host, sdk.boundary).open({ ...request, generation: 2, checkpointRef: 'TEST-checkpoint' }), /checkpoint-incompatible/u);
  assert.equal(sdk.calls, 1);
});
