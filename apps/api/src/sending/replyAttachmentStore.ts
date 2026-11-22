import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ReplyAttachment } from '@lc/core';

/** The bytes behind reply_attachments rows: the raw-mail bucket under <tenantId>/outbound/<mailboxId>/<attachmentId>. */
export interface ReplyAttachmentStore {
  putAttachment(s3Key: string, content: Uint8Array, contentType: string): Promise<void>;
  readAttachment(attachment: ReplyAttachment): Promise<Uint8Array>;
  deleteAttachment(s3Key: string): Promise<void>;
}

export function replyAttachmentS3Key(
  { tenantId, mailboxId }: { tenantId: string; mailboxId: string },
  attachmentId: string,
): string {
  return `${tenantId}/outbound/${mailboxId}/${attachmentId}`;
}

export function createS3ReplyAttachmentStore(input: {
  s3Client: S3Client;
  bucketName: string;
}): ReplyAttachmentStore {
  const { s3Client, bucketName } = input;
  return {
    async putAttachment(s3Key, content, contentType) {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
          Body: content,
          ContentType: contentType,
        }),
      );
    },
    async readAttachment(attachment) {
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: attachment.s3Key }),
      );
      if (!object.Body) throw new Error(`empty object ${attachment.s3Key}`);
      return object.Body.transformToByteArray();
    },
    async deleteAttachment(s3Key) {
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: s3Key }));
    },
  };
}
