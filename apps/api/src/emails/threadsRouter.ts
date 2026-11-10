import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import type { EmailRepository } from '@lc/core';
import type { ThreadResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { toEmailDetailResponse } from './emailResponses.js';

export interface ThreadsRouterDependencies {
  emailRepository: EmailRepository;
  requireSession: RequestHandler;
}

/** Gmail thread ids are opaque hex strings; anything else can match nothing. */
const GMAIL_THREAD_ID_PATTERN = /^[0-9a-f]{1,32}$/;

/**
 * One conversation of the signed-in person's mailbox, mounted at /v1/mailbox/threads.
 *   GET /:gmailThreadId   every stored message of the thread, inbox and sent, oldest first, each
 *                         with bodies and current classification; 404 when the mailbox holds none
 * Unpaginated: a mail thread is tens of messages at most, and the view needs all of them anyway.
 */
export function createThreadsRouter({
  emailRepository,
  requireSession,
}: ThreadsRouterDependencies): Router {
  const router = express.Router();

  router.get('/:gmailThreadId', requireSession, async (request, response) => {
    const { gmailThreadId } = request.params;
    // Express types a param as string | string[] | undefined; a repeated or missing one can match nothing either.
    if (typeof gmailThreadId !== 'string' || !GMAIL_THREAD_ID_PATTERN.test(gmailThreadId)) {
      throw createHttpError(404, 'not_found');
    }
    const emails = await emailRepository.listThreadEmails(getSession(response), gmailThreadId);
    if (emails.length === 0) throw createHttpError(404, 'not_found');
    const body: ThreadResponse = { gmailThreadId, emails: emails.map(toEmailDetailResponse) };
    response.json(body);
  });

  return router;
}
