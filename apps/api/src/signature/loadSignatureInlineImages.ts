import { listSignatureImageContentIds } from '@lc/core';
import type {
  InlineImage,
  MailboxConnection,
  MailboxScope,
  SignatureImageRepository,
} from '@lc/core';
import type { SignatureImageStore } from './signatureImageStore.js';

export interface SignatureInlineImagesDependencies {
  signatureImageRepository: SignatureImageRepository;
  /** Undefined when no bucket is configured: the HTML signature then goes out without its images. */
  signatureImageStore: SignatureImageStore | undefined;
}

/**
 * The images the mailbox's HTML signature references, with their bytes, ready for
 * composeOutboundMime. Empty when the signature is text only or references nothing. A reference
 * to an image whose row or object is gone (or cannot be read) is skipped: that mail shows a broken
 * image, which beats not sending. The sanitiser on save keeps that from happening in the first place.
 */
export async function loadSignatureInlineImages(
  { signatureImageRepository, signatureImageStore }: SignatureInlineImagesDependencies,
  scope: MailboxScope,
  connection: MailboxConnection,
): Promise<InlineImage[]> {
  if (!connection.signatureHtml) return [];
  const contentIds = [...new Set(listSignatureImageContentIds(connection.signatureHtml))];
  if (contentIds.length === 0) return [];
  if (!signatureImageStore) {
    console.warn('signature references images but no bucket is configured; sending without them', {
      mailboxId: scope.mailboxId,
    });
    return [];
  }
  const images = await signatureImageRepository.findSignatureImages(scope, contentIds);
  const loaded = await Promise.all(
    images.map(async (image): Promise<InlineImage | undefined> => {
      try {
        return {
          contentId: image.id,
          content: await signatureImageStore.readImage(image),
          contentType: image.contentType,
          fileName: image.fileName,
        };
      } catch (error) {
        console.warn('signature image could not be read; sending without it', {
          mailboxId: scope.mailboxId,
          imageId: image.id,
          error,
        });
        return undefined;
      }
    }),
  );
  return loaded.filter((image): image is InlineImage => image !== undefined);
}
