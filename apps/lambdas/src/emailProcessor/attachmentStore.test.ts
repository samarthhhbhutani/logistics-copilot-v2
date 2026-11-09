import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { attachmentS3Key, createS3AttachmentStore, sha256Hex } from './attachmentStore.js';

const scope = { tenantId: 'tenant-1', mailboxId: 'mailbox-1' };

describe('attachmentStore', () => {
  it('hashes content to lowercase hex and keys objects by tenant and hash only', () => {
    const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(sha256Hex(new Uint8Array())).toBe(emptySha256);
    expect(attachmentS3Key('tenant-1', emptySha256)).toBe(`tenant-1/attachments/${emptySha256}`);
  });

  it('puts the bytes with their content type and describes the row', async () => {
    const sent: unknown[] = [];
    const s3Client = {
      send: async (command: unknown) => void sent.push(command),
    } as unknown as S3Client;
    const store = createS3AttachmentStore({ s3Client, bucketName: 'raw-mail' });
    const content = new TextEncoder().encode('%PDF-1.4');

    const stored = await store.uploadAttachmentToS3(scope, {
      fileName: 'rate-card.pdf',
      contentType: 'application/pdf',
      sizeBytes: content.byteLength,
      content,
      contentId: undefined,
      isInline: false,
    });

    const sha256 = sha256Hex(content);
    expect(stored).toEqual({
      fileName: 'rate-card.pdf',
      contentType: 'application/pdf',
      sizeBytes: content.byteLength,
      sha256,
      s3Key: `tenant-1/attachments/${sha256}`,
      contentId: undefined,
      isInline: false,
    });
    expect(sent).toHaveLength(1);
    expect((sent[0] as { input: unknown }).input).toEqual({
      Bucket: 'raw-mail',
      Key: `tenant-1/attachments/${sha256}`,
      Body: content,
      ContentType: 'application/pdf',
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
    });
  });

  it('gives identical content the same key regardless of file name or mailbox', async () => {
    const s3Client = { send: async () => undefined } as unknown as S3Client;
    const store = createS3AttachmentStore({ s3Client, bucketName: 'raw-mail' });
    const content = new TextEncoder().encode('same bytes');
    const base = {
      contentType: 'text/plain',
      sizeBytes: content.byteLength,
      content,
      contentId: undefined,
      isInline: false,
    };

    const first = await store.uploadAttachmentToS3(scope, { ...base, fileName: 'a.txt' });
    const second = await store.uploadAttachmentToS3(
      { ...scope, mailboxId: 'mailbox-2' },
      { ...base, fileName: 'b.txt' },
    );

    expect(second.s3Key).toBe(first.s3Key);
    expect(second.fileName).toBe('b.txt');
  });
});
