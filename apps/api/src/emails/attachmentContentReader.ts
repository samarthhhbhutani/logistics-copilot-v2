import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { AttachmentSummary } from '@lc/core';

export interface AttachmentContentReader {
  /** The stored bytes of one attachment, for a process that needs the file itself rather than a link. */
  readContent(attachment: AttachmentSummary): Promise<Uint8Array>;
}

export function createS3AttachmentContentReader(input: {
  s3Client: S3Client;
  bucketName: string;
}): AttachmentContentReader {
  const { s3Client, bucketName } = input;
  return {
    async readContent(attachment) {
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: attachment.s3Key }),
      );
      if (!object.Body) throw new Error(`empty object ${attachment.s3Key}`);
      return object.Body.transformToByteArray();
    },
  };
}
