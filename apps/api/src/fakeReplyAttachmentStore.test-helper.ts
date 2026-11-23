import type { ReplyAttachmentStore } from './sending/replyAttachmentStore.js';

export interface FakeReplyAttachmentStore extends ReplyAttachmentStore {
  /** What has been put and not deleted, by S3 key. */
  objects: Map<string, { content: Uint8Array; contentType: string }>;
  /** Make the next deleteAttachment throw, to exercise the row-deleted-object-left path. */
  failNextDelete: boolean;
}

/** Stands in for the raw-mail bucket: keeps the uploaded bytes in memory. */
export function createFakeReplyAttachmentStore(): FakeReplyAttachmentStore {
  const fake: FakeReplyAttachmentStore = {
    objects: new Map(),
    failNextDelete: false,
    async putAttachment(s3Key, content, contentType) {
      fake.objects.set(s3Key, { content, contentType });
    },
    async readAttachment(attachment) {
      const object = fake.objects.get(attachment.s3Key);
      if (!object) throw new Error(`fake store: no object ${attachment.s3Key}`);
      return object.content;
    },
    async deleteAttachment(s3Key) {
      if (fake.failNextDelete) {
        fake.failNextDelete = false;
        throw new Error('fake store: delete failed');
      }
      fake.objects.delete(s3Key);
    },
  };
  return fake;
}
