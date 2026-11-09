import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { MailboxScope } from '@lc/core';

export interface RawMailStore {
  /** Writes the RFC 822 bytes and returns the key stored on the emails row. Overwriting is harmless: same bytes. */
  putRawEmail(scope: MailboxScope, gmailMessageId: string, raw: Uint8Array): Promise<string>;
}

/** Deterministic, so a redelivered or racing processor writes the same object, not a second copy. */
export function rawEmailS3Key(scope: MailboxScope, gmailMessageId: string): string {
  return `${scope.tenantId}/${scope.mailboxId}/${gmailMessageId}.eml`;
}

export function createS3RawMailStore(input: {
  s3Client: S3Client;
  bucketName: string;
}): RawMailStore {
  const { s3Client, bucketName } = input;
  return {
    async putRawEmail(scope, gmailMessageId, raw) {
      const key = rawEmailS3Key(scope, gmailMessageId);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: raw,
          ContentType: 'message/rfc822',
        }),
      );
      return key;
    },
  };
}
