import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { createS3RawMailStore, rawEmailS3Key } from './rawMailStore.js';

const scope = { tenantId: 'tenant-1', mailboxId: 'mailbox-1' };

describe('rawMailStore', () => {
  it('keys the object by tenant, mailbox and Gmail message id', () => {
    expect(rawEmailS3Key(scope, 'gm-1')).toBe('tenant-1/mailbox-1/gm-1.eml');
  });

  it('puts the bytes as message/rfc822 and returns the key', async () => {
    const s3Client = new S3Client({});
    const s3Mock = mockClient(s3Client);
    s3Mock.on(PutObjectCommand).resolves({});
    const store = createS3RawMailStore({ s3Client, bucketName: 'raw-mail' });

    const key = await store.putRawEmail(scope, 'gm-1', new Uint8Array([1, 2, 3]));

    expect(key).toBe('tenant-1/mailbox-1/gm-1.eml');
    const putInput = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(putInput).toMatchObject({
      Bucket: 'raw-mail',
      Key: 'tenant-1/mailbox-1/gm-1.eml',
      ContentType: 'message/rfc822',
    });
    expect(putInput.Body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('propagates a failed put so the record is retried', async () => {
    const s3Client = new S3Client({});
    mockClient(s3Client).on(PutObjectCommand).rejects(new Error('SlowDown'));
    const store = createS3RawMailStore({ s3Client, bucketName: 'raw-mail' });

    await expect(store.putRawEmail(scope, 'gm-1', new Uint8Array())).rejects.toThrow('SlowDown');
  });
});
