import { randomUUID } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { fileTypeFromBuffer } from 'file-type';
import createHttpError from 'http-errors';
import { listSignatureImageContentIds } from '@lc/core';
import type {
  MailboxConnectionRepository,
  SignatureImage,
  SignatureImageRepository,
} from '@lc/core';
import {
  SIGNATURE_IMAGE_CONTENT_TYPES,
  SIGNATURE_IMAGE_MAX_BYTES,
  SIGNATURE_IMAGES_MAX_PER_MAILBOX,
  uploadSignatureImageQuerySchema,
} from '@lc/contract';
import type {
  ListSignatureImagesResponse,
  SignatureImageContentType,
  SignatureImageResponse,
} from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';
import { parseRequestQuery } from '../http/parseRequestQuery.js';
import { signatureImageS3Key } from './signatureImageStore.js';
import type { SignatureImagePreviewUrl, SignatureImageStore } from './signatureImageStore.js';

export interface SignatureImagesRouterDependencies {
  signatureImageRepository: SignatureImageRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  /** Undefined when the API has no bucket configured (local dev, tests): every route answers 503. */
  signatureImageStore: SignatureImageStore | undefined;
  requireSession: RequestHandler;
}

/**
 * Images for the signed-in mailbox's HTML signature, mounted at /v1/mailbox/signature/images.
 *   GET    /           the mailbox's images with preview links, oldest first
 *   POST   /?fileName= raw image bytes (png, jpeg, gif; <= 200 KB; <= 5 per mailbox); 201 with the image
 *   DELETE /:imageId   204; 409 signature_image_in_use while the stored signature references it
 * Image ids double as the `cid:` the signature HTML uses, so the sanitiser can check references
 * against this mailbox's uploads.
 */
export function createSignatureImagesRouter({
  signatureImageRepository,
  mailboxConnectionRepository,
  signatureImageStore,
  requireSession,
}: SignatureImagesRouterDependencies): Router {
  const router = express.Router();

  const requireStore = (store: SignatureImageStore | undefined): store is SignatureImageStore =>
    store !== undefined;

  router.get('/', requireSession, async (_request, response) => {
    if (!requireStore(signatureImageStore)) {
      response.status(503).json({ error: 'signature_images_unavailable' });
      return;
    }
    const session = getSession(response);
    const images = await signatureImageRepository.listSignatureImages(session);
    const body: ListSignatureImagesResponse = {
      images: await Promise.all(
        images.map(async (image) =>
          toSignatureImageResponse(image, await signatureImageStore.createPreviewUrl(image)),
        ),
      ),
    };
    response.json(body);
  });

  router.post('/', requireSession, rawImageBody, async (request, response) => {
    if (!requireStore(signatureImageStore)) {
      response.status(503).json({ error: 'signature_images_unavailable' });
      return;
    }
    const session = getSession(response);
    const { fileName } = parseRequestQuery(uploadSignatureImageQuerySchema, request.query);
    const content = request.body;
    if (!Buffer.isBuffer(content) || content.length === 0) {
      throw createHttpError(415, 'unsupported_image_type');
    }
    // The declared type must be one we take, and the bytes must really be that type: a mail client
    // renders what the bytes are, whatever the header said.
    const declaredType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    const detected = await fileTypeFromBuffer(content);
    if (!isSignatureImageContentType(declaredType) || detected?.mime !== declaredType) {
      throw createHttpError(415, 'unsupported_image_type');
    }
    const existing = await signatureImageRepository.listSignatureImages(session);
    if (existing.length >= SIGNATURE_IMAGES_MAX_PER_MAILBOX) {
      throw createHttpError(409, 'signature_image_limit_reached');
    }
    const imageId = randomUUID();
    const s3Key = signatureImageS3Key(session.mailboxId, imageId);
    // Object first, row second: a row without bytes would break every mail; an object without a row is only litter.
    await signatureImageStore.putImage(s3Key, content, declaredType);
    const image = await signatureImageRepository.createSignatureImage(session, {
      id: imageId,
      fileName: fileName ?? `image.${detected.ext}`,
      contentType: declaredType,
      sizeBytes: content.length,
      s3Key,
    });
    response
      .status(201)
      .json(toSignatureImageResponse(image, await signatureImageStore.createPreviewUrl(image)));
  });

  router.delete('/:imageId', requireSession, async (request, response) => {
    if (!requireStore(signatureImageStore)) {
      response.status(503).json({ error: 'signature_images_unavailable' });
      return;
    }
    const imageId = parseIdOr404(request.params.imageId);
    const session = getSession(response);
    const connection = await mailboxConnectionRepository.findMailboxConnection(session);
    if (
      connection?.signatureHtml &&
      listSignatureImageContentIds(connection.signatureHtml).includes(imageId)
    ) {
      throw createHttpError(409, 'signature_image_in_use');
    }
    const deleted = await signatureImageRepository.deleteSignatureImage(session, imageId);
    if (!deleted) throw createHttpError(404, 'not_found');
    // The row is gone, so nothing sends this image again; a leftover object is litter, not a fault.
    try {
      await signatureImageStore.deleteImage(deleted.s3Key);
    } catch (error) {
      console.warn('signature image object not deleted', { s3Key: deleted.s3Key, error });
    }
    response.status(204).end();
  });

  return router;
}

/**
 * Reads the raw body for the image types we take; any other Content-Type leaves `request.body`
 * unset (415 below). Oversize bodies become 413 image_too_large instead of body-parser's text.
 */
const rawImageBody: RequestHandler = (request: Request, response: Response, next: NextFunction) => {
  express.raw({ type: [...SIGNATURE_IMAGE_CONTENT_TYPES], limit: SIGNATURE_IMAGE_MAX_BYTES })(
    request,
    response,
    (error?: unknown) => {
      if (isEntityTooLarge(error)) {
        next(createHttpError(413, 'image_too_large'));
        return;
      }
      next(error);
    },
  );
};

function isEntityTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'entity.too.large'
  );
}

function isSignatureImageContentType(
  value: string | undefined,
): value is SignatureImageContentType {
  return (SIGNATURE_IMAGE_CONTENT_TYPES as readonly string[]).includes(value ?? '');
}

function toSignatureImageResponse(
  image: SignatureImage,
  previewUrl: SignatureImagePreviewUrl,
): SignatureImageResponse {
  return {
    id: image.id,
    fileName: image.fileName,
    contentType: image.contentType as SignatureImageContentType,
    sizeBytes: image.sizeBytes,
    contentId: image.id,
    previewUrl: previewUrl.url,
    previewUrlExpiresAt: previewUrl.expiresAt.toISOString(),
    createdAt: image.createdAt.toISOString(),
  };
}
