import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import { z } from 'zod';
import type { AttachmentRepository, AttachmentSummary } from '@lc/core';
import type {
  AttachmentDownloadUrlResponse,
  AttachmentSummaryResponse,
  ListAttachmentsResponse,
} from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import type { AttachmentDownloadUrlSigner } from './attachmentDownloadUrlSigner.js';

export interface AttachmentsRouterDependencies {
  attachmentRepository: AttachmentRepository;
  /** Undefined when the API has no bucket configured (local dev, tests): listing works, download links answer 503. */
  attachmentDownloadUrlSigner: AttachmentDownloadUrlSigner | undefined;
  requireSession: RequestHandler;
}

const uuidSchema = z.uuid();

/** A malformed id can match nothing, so it gets the same answer as an unknown one. */
function parseIdOr404(value: unknown): string {
  const result = uuidSchema.safeParse(value);
  if (!result.success) throw createHttpError(404, 'not_found');
  return result.data;
}

/**
 * Files of the signed-in person's mail, mounted at /v1/mailbox/emails.
 *   GET /:emailId/attachments                                 metadata, inline parts included
 *   GET /:emailId/attachments/:attachmentId/download-url      short-lived presigned S3 link
 * Both answer 404 unless the email is in the session's mailbox and tenant.
 */
export function createAttachmentsRouter({
  attachmentRepository,
  attachmentDownloadUrlSigner,
  requireSession,
}: AttachmentsRouterDependencies): Router {
  const router = express.Router();

  router.get('/:emailId/attachments', requireSession, async (request, response) => {
    const emailId = parseIdOr404(request.params.emailId);
    const session = getSession(response);
    const attachments = await attachmentRepository.listAttachments(session, emailId);
    if (!attachments) throw createHttpError(404, 'not_found');
    const body: ListAttachmentsResponse = {
      emailId,
      attachments: attachments.map(toAttachmentSummaryResponse),
    };
    response.json(body);
  });

  router.get(
    '/:emailId/attachments/:attachmentId/download-url',
    requireSession,
    async (request, response) => {
      const emailId = parseIdOr404(request.params.emailId);
      const attachmentId = parseIdOr404(request.params.attachmentId);
      // Sent directly: the app's error handler reports every thrown 5xx as internal_error.
      if (!attachmentDownloadUrlSigner) {
        response.status(503).json({ error: 'attachments_unavailable' });
        return;
      }
      const session = getSession(response);
      const attachment = await attachmentRepository.findAttachment(session, emailId, attachmentId);
      if (!attachment) throw createHttpError(404, 'not_found');
      const downloadUrl = await attachmentDownloadUrlSigner.createDownloadUrl(attachment);
      const body: AttachmentDownloadUrlResponse = {
        url: downloadUrl.url,
        expiresAt: downloadUrl.expiresAt.toISOString(),
      };
      response.setHeader('Cache-Control', 'no-store');
      response.json(body);
    },
  );

  return router;
}

function toAttachmentSummaryResponse(attachment: AttachmentSummary): AttachmentSummaryResponse {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    isInline: attachment.isInline,
  };
}
