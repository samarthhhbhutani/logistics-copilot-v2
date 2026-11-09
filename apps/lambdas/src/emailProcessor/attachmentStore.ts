import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { MailboxScope, ParsedAttachment, StoredAttachment } from '@lc/core';

export interface AttachmentStore {
  /** Writes the bytes under the tenant, addressed by content, and returns what the attachments row needs. */
  uploadAttachmentToS3(
    scope: MailboxScope,
    attachment: ParsedAttachment,
  ): Promise<StoredAttachment>;
}

export function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Content-addressed within the tenant: the same file sent many times is one object, and nothing
 * one tenant stores can be named, probed or shared by another. The mailbox is not part of the
 * key; the attachments row ties the file to its email.
 */
export function attachmentS3Key(tenantId: string, sha256: string): string {
  return `${tenantId}/attachments/${sha256}`;
}

export function createS3AttachmentStore(input: {
  s3Client: S3Client;
  bucketName: string;
}): AttachmentStore {
  const { s3Client, bucketName } = input;
  return {
    async uploadAttachmentToS3(scope, attachment) {
      const sha256 = sha256Hex(attachment.content);
      const s3Key = attachmentS3Key(scope.tenantId, sha256);
      // Unconditional put: an existing object has the same bytes, so overwriting is harmless and
      // cheaper than a HEAD round trip first. The checksum makes S3 verify the bytes match the key.
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
          Body: attachment.content,
          ContentType: attachment.contentType,
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        }),
      );
      return {
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        sha256,
        s3Key,
        contentId: attachment.contentId,
        isInline: attachment.isInline,
      };
    },
  };
}
