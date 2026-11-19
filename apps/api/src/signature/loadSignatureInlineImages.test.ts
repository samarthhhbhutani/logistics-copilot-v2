import { describe, expect, it } from 'vitest';
import type { MailboxConnection } from '@lc/core';
import { createFakeSignatureImageStore } from '../fakeSignatureImageStore.test-helper.js';
import { createInMemoryRepositories } from '../inMemoryRepositories.test-helper.js';
import { loadSignatureInlineImages } from './loadSignatureInlineImages.js';

const scope = { mailboxId: 'mailbox-1', tenantId: 'tenant-1' };
const connectionBase: MailboxConnection = {
  mailboxId: scope.mailboxId,
  tenantId: scope.tenantId,
  emailAddress: 'ops@bhatia.example',
  gmailConnectionStatus: 'connected',
  gmailConnectedAt: null,
  encryptedRefreshToken: null,
  watchExpiresAt: null,
  signature: 'Ops Desk',
  signatureHtml: null,
};
const logoBytes = Buffer.from('89504e47', 'hex');

async function seededImage() {
  const { signatureImageRepository } = createInMemoryRepositories();
  const signatureImageStore = createFakeSignatureImageStore();
  const image = await signatureImageRepository.createSignatureImage(scope, {
    id: '00000000-0000-4000-8000-00000000000a',
    fileName: 'logo.png',
    contentType: 'image/png',
    sizeBytes: logoBytes.length,
    s3Key: `signatures/${scope.mailboxId}/00000000-0000-4000-8000-00000000000a`,
  });
  await signatureImageStore.putImage(image.s3Key, logoBytes, image.contentType);
  return { signatureImageRepository, signatureImageStore, image };
}

describe('loadSignatureInlineImages', () => {
  it('returns the referenced images with their bytes, once each, skipping unknown references', async () => {
    const { signatureImageRepository, signatureImageStore, image } = await seededImage();
    const inlineImages = await loadSignatureInlineImages(
      { signatureImageRepository, signatureImageStore },
      scope,
      {
        ...connectionBase,
        signatureHtml: `<img src="cid:${image.id}"><p>Ops Desk</p><img src="cid:${image.id}"><img src="cid:gone">`,
      },
    );
    expect(inlineImages).toEqual([
      { contentId: image.id, content: logoBytes, contentType: 'image/png', fileName: 'logo.png' },
    ]);
  });

  it('returns nothing for a text-only signature, an HTML signature without images, or no bucket', async () => {
    const { signatureImageRepository, signatureImageStore, image } = await seededImage();
    const dependencies = { signatureImageRepository, signatureImageStore };
    expect(await loadSignatureInlineImages(dependencies, scope, connectionBase)).toEqual([]);
    expect(
      await loadSignatureInlineImages(dependencies, scope, {
        ...connectionBase,
        signatureHtml: '<p>Ops Desk</p>',
      }),
    ).toEqual([]);
    expect(
      await loadSignatureInlineImages(
        { signatureImageRepository, signatureImageStore: undefined },
        scope,
        { ...connectionBase, signatureHtml: `<img src="cid:${image.id}">` },
      ),
    ).toEqual([]);
  });

  it('skips an image whose object is gone instead of failing the send', async () => {
    const { signatureImageRepository, signatureImageStore, image } = await seededImage();
    const badge = await signatureImageRepository.createSignatureImage(scope, {
      id: '00000000-0000-4000-8000-00000000000b',
      fileName: 'badge.gif',
      contentType: 'image/gif',
      sizeBytes: 3,
      s3Key: `signatures/${scope.mailboxId}/00000000-0000-4000-8000-00000000000b`,
    });
    const inlineImages = await loadSignatureInlineImages(
      { signatureImageRepository, signatureImageStore },
      scope,
      {
        ...connectionBase,
        signatureHtml: `<img src="cid:${badge.id}"><img src="cid:${image.id}">`,
      },
    );
    expect(inlineImages.map((inlineImage) => inlineImage.contentId)).toEqual([image.id]);
  });

  it("does not hand out another mailbox's image", async () => {
    const { signatureImageRepository, signatureImageStore, image } = await seededImage();
    expect(
      await loadSignatureInlineImages(
        { signatureImageRepository, signatureImageStore },
        { mailboxId: 'mailbox-2', tenantId: scope.tenantId },
        { ...connectionBase, mailboxId: 'mailbox-2', signatureHtml: `<img src="cid:${image.id}">` },
      ),
    ).toEqual([]);
  });
});
