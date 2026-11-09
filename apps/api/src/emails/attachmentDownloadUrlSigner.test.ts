import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS,
  attachmentContentDisposition,
  createS3AttachmentDownloadUrlSigner,
} from './attachmentDownloadUrlSigner.js';

describe('attachmentContentDisposition', () => {
  it('forces a download and carries the real name in filename*', () => {
    expect(attachmentContentDisposition('rate-card.pdf')).toBe(
      `attachment; filename="rate-card.pdf"; filename*=UTF-8''rate-card.pdf`,
    );
  });

  it('keeps an ASCII fallback for non-ASCII and quoted names', () => {
    expect(attachmentContentDisposition('Tarif Rotterdam "été" (1).pdf')).toBe(
      `attachment; filename="Tarif Rotterdam __t__ (1).pdf"; filename*=UTF-8''Tarif%20Rotterdam%20%22%C3%A9t%C3%A9%22%20%281%29.pdf`,
    );
  });

  it('never lets a header-breaking name through', () => {
    const disposition = attachmentContentDisposition('evil\r\nX-Injected: 1');
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain('filename="evil X-Injected: 1"');
    expect(attachmentContentDisposition('   ')).toContain('filename="attachment"');
    expect(attachmentContentDisposition('x'.repeat(500))).toContain(
      `filename="${'x'.repeat(200)}"`,
    );
  });
});

describe('createS3AttachmentDownloadUrlSigner', () => {
  const attachment = {
    id: '00000000-0000-4000-8000-000000000002',
    emailId: '00000000-0000-4000-8000-000000000001',
    fileName: 'rate card.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    sha256: 'ab'.repeat(32),
    s3Key: `tenant-1/attachments/${'ab'.repeat(32)}`,
    contentId: undefined,
    isInline: false,
  };

  it('presigns a GET for the object with download headers and a 5 minute expiry, offline', async () => {
    const signedAt = new Date('2026-11-10T00:00:00Z');
    const signer = createS3AttachmentDownloadUrlSigner({
      s3Client: new S3Client({
        region: 'ap-south-1',
        credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' },
      }),
      bucketName: 'raw-mail-test',
      now: () => signedAt,
    });

    const { url, expiresAt } = await signer.createDownloadUrl(attachment);

    const parsed = new URL(url);
    expect(parsed.host).toBe('raw-mail-test.s3.ap-south-1.amazonaws.com');
    expect(parsed.pathname).toBe(`/${attachment.s3Key}`);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe(
      String(ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS),
    );
    expect(parsed.searchParams.get('X-Amz-Date')).toBe('20261110T000000Z');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get('response-content-disposition')).toBe(
      attachmentContentDisposition('rate card.pdf'),
    );
    expect(parsed.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(expiresAt.toISOString()).toBe('2026-11-10T00:05:00.000Z');
  });
});
