import { createHash } from 'node:crypto';
import type { Input } from '@agent-teams/provider-session-contracts';
import type { AttachmentPort } from '../../../../src/features/provider-session-implementation/adapters/provider-session-io/attachments.ts';
export function artifact(artifactId = 'TEST-image', mimeType = 'image/png', text = 'TEST bytes') {
  const bytes = Buffer.from(text);
  return { bytes, reference: { artifactId, mimeType, byteLength: bytes.byteLength, digest: createHash('sha256').update(bytes).digest('hex') } };
}
export function attachmentPort(model: string, artifacts: readonly ReturnType<typeof artifact>[]): AttachmentPort {
  return { model, revision: 'TEST-attachment-policy', mimeTypes: [...new Set(artifacts.map(item => item.reference.mimeType))],
    async resolve(binding) {
      const item = artifacts.find(value => value.reference.artifactId === binding.reference.artifactId);
      return item && { binding, bytes: item.bytes, nativePath: '/TEST-unused/attachments/' + item.reference.artifactId };
    } };
}
export const attachedInput = (attachments: NonNullable<Input['attachments']>, n = 1): Input => ({ inputId: 'TEST-input-' + n, operationRef: 'TEST-operation-' + n, content: 'TEST text', attachments });
