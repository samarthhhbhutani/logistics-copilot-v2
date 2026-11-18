import type { SignatureImageStore } from './signature/signatureImageStore.js';

export interface FakeSignatureImageStore extends SignatureImageStore {
  /** What has been put and not deleted, by S3 key. */
  objects: Map<string, { content: Uint8Array; contentType: string }>;
  /** Make the next deleteImage throw, to exercise the row-deleted-object-left path. */
  failNextDelete: boolean;
}

/** Stands in for the raw-mail bucket: keeps bytes in memory, answers recognisable preview URLs. */
export function createFakeSignatureImageStore(): FakeSignatureImageStore {
  const fake: FakeSignatureImageStore = {
    objects: new Map(),
    failNextDelete: false,
    async putImage(s3Key, content, contentType) {
      fake.objects.set(s3Key, { content, contentType });
    },
    async readImage(image) {
      const object = fake.objects.get(image.s3Key);
      if (!object) throw new Error(`fake store: no object ${image.s3Key}`);
      return object.content;
    },
    async deleteImage(s3Key) {
      if (fake.failNextDelete) {
        fake.failNextDelete = false;
        throw new Error('fake store: delete failed');
      }
      fake.objects.delete(s3Key);
    },
    async createPreviewUrl(image) {
      return {
        url: `https://fake-bucket.example/${image.s3Key}?preview=1`,
        expiresAt: new Date('2026-11-20T01:00:00Z'),
      };
    },
  };
  return fake;
}
