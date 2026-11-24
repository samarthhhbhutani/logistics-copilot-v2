import { createHash, randomUUID } from 'node:crypto';
import { parse as parseContentType } from 'content-type';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { fileTypeFromBuffer } from 'file-type';
import createHttpError from 'http-errors';
import type { OutboundAttachment, OutboundAttachmentRepository } from '@lc/core';
import {
  OUTBOUND_ATTACHMENT_MAX_BYTES,
  isGmailBlockedExtension,
  hasGmailBlockedExtension,
  uploadOutboundAttachmentQuerySchema,
} from '@lc/contract';
import type { OutboundAttachmentResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';
import { parseRequestQuery } from '../http/parseRequestQuery.js';
import { outboundAttachmentS3Key } from './outboundAttachmentStore.js';
import type { OutboundAttachmentStore } from './outboundAttachmentStore.js';

export interface OutboundAttachmentsRouterDependencies {
  outboundAttachmentRepository: OutboundAttachmentRepository;
  /** Undefined when the API has no bucket configured (local dev, tests): every route answers 503. */
  outboundAttachmentStore: OutboundAttachmentStore | undefined;
  requireSession: RequestHandler;
}

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * Files the operator attaches to an outgoing mail (a reply today, an RFQ next), mounted at
 * /v1/mailbox/outbound-attachments. Uploaded as
 * the operator picks them, before the send, so the composer can show each one and the send only
 * names ids.
 *   POST   /?fileName=     raw bytes (<= 10 MB); 201 with the attachment
 *   DELETE /:attachmentId  204 for an upload no mail carries; 404 otherwise
 * The per-mail count and total size are the send's business, not the upload's.
 */
export function createOutboundAttachmentsRouter({
  outboundAttachmentRepository,
  outboundAttachmentStore,
  requireSession,
}: OutboundAttachmentsRouterDependencies): Router {
  const router = express.Router();

  const requireStore = (
    store: OutboundAttachmentStore | undefined,
  ): store is OutboundAttachmentStore => store !== undefined;

  router.post('/', requireSession, rawAttachmentBody, async (request, response) => {
    if (!requireStore(outboundAttachmentStore)) {
      response.status(503).json({ error: 'outbound_attachments_unavailable' });
      return;
    }
    const session = getSession(response);
    const { fileName } = parseRequestQuery(uploadOutboundAttachmentQuerySchema, request.query);
    if (hasGmailBlockedExtension(fileName)) {
      throw createHttpError(415, 'blocked_file_type');
    }
    const content = request.body;
    if (!Buffer.isBuffer(content) || content.length === 0) {
      throw createHttpError(400, 'empty_attachment');
    }
    // Trust the bytes over the header when they can be told apart (a renamed .exe is still an exe
    // to Gmail); fall back to what the browser said, then to octet-stream.
    const detected = await fileTypeFromBuffer(content);
    if (detected && isGmailBlockedExtension(detected.ext)) {
      throw createHttpError(415, 'blocked_file_type');
    }
    const contentType = detected?.mime ?? declaredContentType(request) ?? FALLBACK_CONTENT_TYPE;
    const attachmentId = randomUUID();
    const s3Key = outboundAttachmentS3Key(session, attachmentId);
    // Object first, row second: a row without bytes would fail the send; an object without a row is only litter.
    await outboundAttachmentStore.putAttachment(s3Key, content, contentType);
    const attachment = await outboundAttachmentRepository.createOutboundAttachment(session, {
      id: attachmentId,
      fileName,
      contentType,
      sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      s3Key,
    });
    response.status(201).json(toOutboundAttachmentResponse(attachment));
  });

  router.delete('/:attachmentId', requireSession, async (request, response) => {
    if (!requireStore(outboundAttachmentStore)) {
      response.status(503).json({ error: 'outbound_attachments_unavailable' });
      return;
    }
    const attachmentId = parseIdOr404(request.params.attachmentId);
    const session = getSession(response);
    const deleted = await outboundAttachmentRepository.deleteUnsentOutboundAttachment(
      session,
      attachmentId,
    );
    if (!deleted) throw createHttpError(404, 'not_found');
    // The row is gone, so no send can pick the file up; a leftover object is litter, not a fault.
    try {
      await outboundAttachmentStore.deleteAttachment(deleted.s3Key);
    } catch (error) {
      console.warn('outbound attachment object not deleted', { s3Key: deleted.s3Key, error });
    }
    response.status(204).end();
  });

  return router;
}

/** Reads any body as bytes; oversize bodies become 413 attachment_too_large instead of body-parser's text. */
const rawAttachmentBody: RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  express.raw({ type: () => true, limit: OUTBOUND_ATTACHMENT_MAX_BYTES })(
    request,
    response,
    (error?: unknown) => {
      if (isEntityTooLarge(error)) {
        next(createHttpError(413, 'attachment_too_large'));
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

/** The media type of the Content-Type header, lower-cased, without parameters; undefined when absent or malformed. */
function declaredContentType(request: Request): string | undefined {
  const header = request.headers['content-type'];
  if (!header) return undefined;
  try {
    return parseContentType(header).type;
  } catch {
    return undefined;
  }
}

export function toOutboundAttachmentResponse(
  attachment: OutboundAttachment,
): OutboundAttachmentResponse {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt.toISOString(),
  };
}
