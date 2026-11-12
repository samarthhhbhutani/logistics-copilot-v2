import { describe, expect, it } from 'vitest';
import {
  attachmentDownloadUrlResponseSchema,
  listAttachmentsResponseSchema,
} from './attachments.js';

describe('attachment contracts', () => {
  it('accepts a list with inline and regular files', () => {
    const parsed = listAttachmentsResponseSchema.parse({
      emailId: '00000000-0000-4000-8000-000000000001',
      attachments: [
        {
          id: '00000000-0000-4000-8000-000000000002',
          fileName: 'rate-card.pdf',
          contentType: 'application/pdf',
          sizeBytes: 12345,
          isInline: false,
          contentId: null,
        },
        {
          id: '00000000-0000-4000-8000-000000000003',
          fileName: 'logo.png',
          contentType: 'image/png',
          sizeBytes: 0,
          isInline: true,
          contentId: 'logo@acme.com',
        },
      ],
    });
    expect(parsed.attachments.map((attachment) => attachment.contentId)).toEqual([
      null,
      'logo@acme.com',
    ]);
  });

  it('defaults a missing contentId to null so older API responses still parse', () => {
    const parsed = listAttachmentsResponseSchema.parse({
      emailId: '00000000-0000-4000-8000-000000000001',
      attachments: [
        {
          id: '00000000-0000-4000-8000-000000000003',
          fileName: 'logo.png',
          contentType: 'image/png',
          sizeBytes: 8,
          isInline: true,
        },
      ],
    });
    expect(parsed.attachments[0]!.contentId).toBeNull();
  });

  it('rejects a non-string contentId', () => {
    expect(() =>
      listAttachmentsResponseSchema.parse({
        emailId: '00000000-0000-4000-8000-000000000001',
        attachments: [
          {
            id: '00000000-0000-4000-8000-000000000003',
            fileName: 'logo.png',
            contentType: 'image/png',
            sizeBytes: 8,
            isInline: true,
            contentId: 42,
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects a negative size and a non-URL download link', () => {
    expect(() =>
      listAttachmentsResponseSchema.parse({
        emailId: '00000000-0000-4000-8000-000000000001',
        attachments: [
          {
            id: '00000000-0000-4000-8000-000000000002',
            fileName: 'a',
            contentType: 'b',
            sizeBytes: -1,
            isInline: false,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      attachmentDownloadUrlResponseSchema.parse({
        url: 'not a url',
        expiresAt: '2026-11-10T00:00:00Z',
      }),
    ).toThrow();
    expect(
      attachmentDownloadUrlResponseSchema.parse({
        url: 'https://bucket.s3.ap-south-1.amazonaws.com/t/attachments/abc?X-Amz-Signature=1',
        expiresAt: '2026-11-10T00:05:00.000Z',
      }).url,
    ).toContain('X-Amz-Signature');
  });
});
