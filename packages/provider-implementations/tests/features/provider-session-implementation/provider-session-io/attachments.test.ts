import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachmentFailure, inputFingerprint, prepareAttachments, snapshotInput, validateAttachments } from '../../../../src/features/provider-session-implementation/adapters/provider-session-io/attachments.ts';
import { artifact, attachedInput, attachmentPort } from './attachment-support.ts';

test('ordered attachment snapshot and fingerprint include identity MIME length digest and order', () => {
  const a = artifact('TEST-a'), b = artifact('TEST-b', 'image/jpeg');
  const refs = [a.reference, b.reference]; const input = snapshotInput(attachedInput(refs));
  const fingerprint = inputFingerprint(input);
  refs.reverse(); a.reference.digest = '0'.repeat(64);
  assert.equal(input.attachments?.[0]?.artifactId, 'TEST-a'); assert.equal(inputFingerprint(input), fingerprint);
  assert.notEqual(inputFingerprint(attachedInput(refs)), fingerprint);
  for (const field of ['artifactId', 'mimeType', 'byteLength', 'digest'] as const) {
    const ref = { ...b.reference, [field]: field === 'byteLength' ? 999 : 'different' };
    assert.notEqual(inputFingerprint(attachedInput([ref])), inputFingerprint(attachedInput([b.reference])));
  }
  assert.deepEqual(snapshotInput({ inputId: 'i', operationRef: 'o', content: 'text' }), { inputId: 'i', operationRef: 'o', content: 'text' });
});

test('finite native MIME and frozen budgets intersect Host capability without model-policy duplication', () => {
  const gif = artifact('TEST-gif', 'image/gif'), pdf = artifact('TEST-pdf', 'application/pdf'), video = artifact('TEST-video', 'video/mp4');
  for (const item of [gif, pdf]) { validateAttachments(attachedInput([item.reference]), 'claude', 'TEST-model', attachmentPort('TEST-model', [item])); }
  for (const provider of ['codex', 'opencode-v1', 'opencode-v2'] as const) {
    for (const item of [gif, pdf]) { assert.throws(() => validateAttachments(attachedInput([item.reference]), provider, 'TEST-model', attachmentPort('TEST-model', [item])), /unsupported/u); }
  }
  validateAttachments(attachedInput([video.reference]), 'opencode-v1', 'TEST-model', attachmentPort('TEST-model', [video]));
  assert.throws(() => validateAttachments(attachedInput([video.reference]), 'claude', 'TEST-model', attachmentPort('TEST-model', [video])), /unsupported/u);
  assert.throws(() => validateAttachments(attachedInput([video.reference]), 'opencode-v1', 'other-model', attachmentPort('TEST-model', [video])), /unsupported/u);
  assert.throws(() => validateAttachments(attachedInput([video.reference]), 'opencode-v1', 'TEST-model'), /unsupported/u);
  assert.throws(() => validateAttachments(attachedInput([{ ...video.reference, byteLength: 8 * 1024 * 1024 + 1 }]), 'opencode-v1', 'TEST-model', attachmentPort('TEST-model', [video])), /backpressure/u);
  const image = artifact();
  assert.throws(() => validateAttachments(attachedInput(Array.from({ length: 6 }, (_, i) => ({ ...image.reference, artifactId: 'TEST-' + i }))), 'claude', 'TEST-model', attachmentPort('TEST-model', [image])), /backpressure/u);
});

test('resolver verifies exact private binding bytes digest length path and missing artifacts before handoff', async () => {
  const item = artifact(), input = snapshotInput(attachedInput([item.reference])), port = attachmentPort('TEST-model', [item]);
  const options = { trustedBinding: 'TEST-trusted', sessionRef: 'TEST-session', port, signal: new AbortController().signal, timeoutMs: 100, requirePath: true };
  assert.equal((await prepareAttachments(input, options))[0]?.reference.artifactId, item.reference.artifactId);
  const bad = [
    attachmentPort('TEST-model', []).resolve,
    async (binding: Parameters<typeof port.resolve>[0]) => ({ binding, bytes: Buffer.from('wrong') }),
    async (binding: Parameters<typeof port.resolve>[0]) => ({ binding, bytes: Buffer.alloc(item.bytes.length, 0) }),
    async (binding: Parameters<typeof port.resolve>[0]) => ({ binding: { ...binding, trustedBinding: 'other' }, bytes: item.bytes }),
    async (binding: Parameters<typeof port.resolve>[0]) => ({ binding, bytes: item.bytes, nativePath: 'relative.png' }),
  ];
  for (const resolve of bad) { await assert.rejects(prepareAttachments(input, { ...options, port: { ...port, resolve } }), AttachmentFailure); }
  await assert.rejects(prepareAttachments(input, { ...options, port: { ...port, resolve: () => new Promise(() => {}) }, timeoutMs: 5 }), /dependency-unavailable/u);
  for (const reference of [{ ...item.reference, digest: 'bad' }, { ...item.reference, artifactId: '../bad' }, { ...item.reference, byteLength: 0 }]) { assert.throws(() => snapshotInput(attachedInput([reference])), /invalid-config/u); }
});
