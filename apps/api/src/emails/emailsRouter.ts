import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import { decodeEmailListCursor, encodeEmailListCursor } from '@lc/core';
import type { EmailReadRepository } from '@lc/core';
import { listEmailsQuerySchema } from '@lc/contract';
import type { EmailDetailResponse, ListEmailsResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';
import { parseRequestQuery } from '../http/parseRequestQuery.js';
import { toEmailDetailResponse, toEmailSummaryResponse } from './emailResponses.js';

export interface EmailsRouterDependencies {
  emailReadRepository: EmailReadRepository;
  requireSession: RequestHandler;
}

export { DEFAULT_EMAIL_PAGE_SIZE, MAX_EMAIL_PAGE_SIZE } from '@lc/contract';

/**
 * The signed-in person's mail, mounted at /v1/mailbox/emails.
 *   GET /            ?limit=50&cursor=<opaque>&label=inbox|sent   newest first, list fields plus current classification
 *   GET /:emailId    one mail with bodies and its current classification; 404 outside the mailbox
 * The mailbox is the session's; tenantId rides along as the isolation check.
 */
export function createEmailsRouter({
  emailReadRepository,
  requireSession,
}: EmailsRouterDependencies): Router {
  const router = express.Router();

  router.get('/', requireSession, async (request, response) => {
    const { limit, cursor, label } = parseRequestQuery(listEmailsQuerySchema, request.query);
    const before = cursor ? decodeEmailListCursor(cursor) : undefined;
    if (cursor && !before) throw createHttpError(400, 'invalid_cursor');

    const session = getSession(response);
    const rows = await emailReadRepository.listEmails(session, {
      limit: limit + 1,
      gmailLabel: label,
      before,
    });
    const page = rows.slice(0, limit);
    const lastRow = page.at(-1);
    const body: ListEmailsResponse = {
      mailboxId: session.mailboxId,
      tenantId: session.tenantId,
      emails: page.map(toEmailSummaryResponse),
      nextCursor:
        rows.length > limit && lastRow
          ? encodeEmailListCursor({ receivedAt: lastRow.receivedAt, id: lastRow.id })
          : null,
    };
    response.json(body);
  });

  router.get('/:emailId', requireSession, async (request, response) => {
    const emailId = parseIdOr404(request.params.emailId);
    const email = await emailReadRepository.findEmail(getSession(response), emailId);
    if (!email) throw createHttpError(404, 'not_found');
    const body: EmailDetailResponse = toEmailDetailResponse(email);
    response.json(body);
  });

  return router;
}
