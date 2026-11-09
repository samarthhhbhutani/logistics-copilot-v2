import type { AttachmentDownloadUrlSigner } from './emails/attachmentDownloadUrlSigner.js';

export const fakeDownloadUrlExpiresAt = new Date('2026-11-10T00:05:00.000Z');

/** Encodes the key and file name in the URL so tests can check what was signed, without AWS. */
export function createFakeAttachmentDownloadUrlSigner(): AttachmentDownloadUrlSigner {
  return {
    async createDownloadUrl(attachment) {
      const url = new URL(`https://fake-bucket.example/${attachment.s3Key}`);
      url.searchParams.set('fileName', attachment.fileName);
      return { url: url.toString(), expiresAt: fakeDownloadUrlExpiresAt };
    },
  };
}
