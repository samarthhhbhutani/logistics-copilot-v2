import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import { decodeEmailListCursor, encodeEmailListCursor } from '@lc/core';
import type { EmailRepository, EmailSummary } from '@lc/core';
import { listEmailsQuerySchema } from '@lc/contract';
import type { EmailSummaryResponse, ListEmailsResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseRequestQuery } from '../http/parseRequestQuery.js';

export interface EmailsRouterDependencies {
  emailRepository: EmailRepository;
  requireSession: RequestHandler;
}

export { DEFAULT_EMAIL_PAGE_SIZE, MAX_EMAIL_PAGE_SIZE } from '@lc/contract';

/**
 * The signed-in person's mail, newest first, mounted at /v1/mailbox/emails.
 *   GET /  ?limit=50&cursor=<opaque>&label=inbox|sent
 * The mailbox is the session's; tenantId rides along as the isolation check. Bodies are not
 * listed here (GET /:id, roadmap 3.1).
 */
export function createEmailsRouter({
  emailRepository,
  requireSession,
}: EmailsRouterDependencies): Router {
  const router = express.Router();

  router.get('/', requireSession, async (request, response) => {
    const { limit, cursor, label } = parseRequestQuery(listEmailsQuerySchema, request.query);
    const before = cursor ? decodeEmailListCursor(cursor) : undefined;
    if (cursor && !before) throw createHttpError(400, 'invalid_cursor');

    const session = getSession(response);
    const rows = await emailRepository.listEmails(session, {
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

  return router;
}

function toEmailSummaryResponse(email: EmailSummary): EmailSummaryResponse {
  return {
    id: email.id,
    gmailThreadId: email.gmailThreadId,
    gmailLabel: email.gmailLabel,
    sender: { name: email.senderName, email: email.senderEmail },
    toRecipients: email.toRecipients,
    subject: email.subject,
    snippet: email.snippet,
    receivedAt: email.receivedAt.toISOString(),
  };
}
