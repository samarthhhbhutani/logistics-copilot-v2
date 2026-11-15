import type { AttachmentSummary } from '@lc/core';
import type { AttachmentContentReader } from './emails/attachmentContentReader.js';

/** Serves bytes by s3Key and records what was asked for; a key without bytes fails like a missing object. */
export function createFakeAttachmentContentReader(
  contentByS3Key: Record<string, Uint8Array>,
): AttachmentContentReader & { read: string[] } {
  const read: string[] = [];
  return {
    read,
    async readContent(attachment: AttachmentSummary) {
      read.push(attachment.s3Key);
      const content = contentByS3Key[attachment.s3Key];
      if (!content) throw new Error(`NoSuchKey: ${attachment.s3Key}`);
      return content;
    },
  };
}
