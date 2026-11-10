import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import type { EmailClassificationRepository } from '@lc/core';
import { appendClassificationBodySchema } from '@lc/contract';
import type { CurrentClassificationResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';
import { parseRequestBody } from '../http/parseRequestBody.js';
import { toCurrentClassificationResponse } from './emailResponses.js';

export interface EmailClassificationsRouterDependencies {
  emailClassificationRepository: EmailClassificationRepository;
  requireSession: RequestHandler;
}

/**
 * Operator corrections to a mail's label, mounted at /v1/mailbox/emails.
 *   POST /:emailId/classifications   { label }  201 with the new current classification; 404 outside
 *                                    the session's mailbox and tenant; 409 not_inbound for a SENT mail
 * The rules (any label, always appends) live on EmailClassificationRepository.
 */
export function createEmailClassificationsRouter({
  emailClassificationRepository,
  requireSession,
}: EmailClassificationsRouterDependencies): Router {
  const router = express.Router();

  router.post('/:emailId/classifications', requireSession, async (request, response) => {
    const emailId = parseIdOr404(request.params.emailId);
    const { label } = parseRequestBody(appendClassificationBodySchema, request.body);
    const result = await emailClassificationRepository.appendUserClassification(
      getSession(response),
      emailId,
      label,
    );
    if (result.outcome === 'not_found') throw createHttpError(404, 'not_found');
    if (result.outcome === 'not_inbound') throw createHttpError(409, 'not_inbound');
    const body: CurrentClassificationResponse = toCurrentClassificationResponse(
      result.classification,
    );
    response.status(201).json(body);
  });

  return router;
}
