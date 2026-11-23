import { createHash, randomUUID } from 'node:crypto';
import { parse as parseContentType } from 'content-type';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { fileTypeFromBuffer } from 'file-type';
import createHttpError from 'http-errors';
import type { ReplyAttachment, ReplyAttachmentRepository } from '@lc/core';
import {
  REPLY_ATTACHMENT_MAX_BYTES,
  isGmailBlockedExtension,
  hasGmailBlockedExtension,
  uploadReplyAttachmentQuerySchema,
} from '@lc/contract';
import type { ReplyAttachmentResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';
import { parseRequestQuery } from '../http/parseRequestQuery.js';
import { replyAttachmentS3Key } from './replyAttachmentStore.js';
import type { ReplyAttachmentStore } from './replyAttachmentStore.js';

export interface ReplyAttachmentsRouterDependencies {
  replyAttachmentRepository: ReplyAttachmentRepository;
  /** Undefined when the API has no bucket configured (local dev, tests): every route answers 503. */
  replyAttachmentStore: ReplyAttachmentStore | undefined;
  requireSession: RequestHandler;
}

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * Files the operator attaches to a reply, mounted at /v1/mailbox/reply-attachments. Uploaded as
 * the operator picks them, before the send, so the composer can show each one and the send only
 * names ids.
 *   POST   /?fileName=     raw bytes (<= 10 MB); 201 with the attachment
 *   DELETE /:attachmentId  204 for an upload no mail carries; 404 otherwise
 * The per-reply count and total size are the send's business (PR 4), not the upload's.
 */
export function createReplyAttachmentsRouter({
  replyAttachmentRepository,
  replyAttachmentStore,
  requireSession,
}: ReplyAttachmentsRouterDependencies): Router {
  const router = express.Router();

  const requireStore = (store: ReplyAttachmentStore | undefined): store is ReplyAttachmentStore =>
    store !== undefined;

  router.post('/', requireSession, rawAttachmentBody, async (request, response) => {
    if (!requireStore(replyAttachmentStore)) {
      response.status(503).json({ error: 'reply_attachments_unavailable' });
      return;
    }
    const session = getSession(response);
    const { fileName } = parseRequestQuery(uploadReplyAttachmentQuerySchema, request.query);
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
    const s3Key = replyAttachmentS3Key(session, attachmentId);
    // Object first, row second: a row without bytes would fail the send; an object without a row is only litter.
    await replyAttachmentStore.putAttachment(s3Key, content, contentType);
    const attachment = await replyAttachmentRepository.createReplyAttachment(session, {
      id: attachmentId,
      fileName,
      contentType,
      sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      s3Key,
    });
    response.status(201).json(toReplyAttachmentResponse(attachment));
  });

  router.delete('/:attachmentId', requireSession, async (request, response) => {
    if (!requireStore(replyAttachmentStore)) {
      response.status(503).json({ error: 'reply_attachments_unavailable' });
      return;
    }
    const attachmentId = parseIdOr404(request.params.attachmentId);
    const session = getSession(response);
    const deleted = await replyAttachmentRepository.deleteUnsentReplyAttachment(
      session,
      attachmentId,
    );
    if (!deleted) throw createHttpError(404, 'not_found');
    // The row is gone, so no send can pick the file up; a leftover object is litter, not a fault.
    try {
      await replyAttachmentStore.deleteAttachment(deleted.s3Key);
    } catch (error) {
      console.warn('reply attachment object not deleted', { s3Key: deleted.s3Key, error });
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
  express.raw({ type: () => true, limit: REPLY_ATTACHMENT_MAX_BYTES })(
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

export function toReplyAttachmentResponse(attachment: ReplyAttachment): ReplyAttachmentResponse {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt.toISOString(),
  };
}
