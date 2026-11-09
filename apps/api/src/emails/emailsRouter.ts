import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { decodeEmailListCursor, encodeEmailListCursor } from '@lc/core';
import type { EmailRepository, EmailSummary } from '@lc/core';
import { getSession } from '../auth/requireSession.js';
import { parseRequestQuery } from '../http/parseRequestQuery.js';

export interface EmailsRouterDependencies {
  emailRepository: EmailRepository;
  requireSession: RequestHandler;
}

export const DEFAULT_EMAIL_PAGE_SIZE = 50;
export const MAX_EMAIL_PAGE_SIZE = 100;

const listEmailsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_EMAIL_PAGE_SIZE).default(DEFAULT_EMAIL_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
  label: z.enum(['inbox', 'sent']).optional(),
});

/** The list row as the portal receives it; dates as ISO strings, sender folded into one object. */
export interface EmailSummaryResponse {
  id: string;
  gmailThreadId: string;
  gmailLabel: 'inbox' | 'sent';
  sender: { name: string; email: string | null };
  toRecipients: { name: string; address: string }[];
  subject: string;
  snippet: string;
  receivedAt: string;
}

export interface ListEmailsResponse {
  emails: EmailSummaryResponse[];
  /** Pass back as ?cursor= for the next page; null when this was the last page. */
  nextCursor: string | null;
}

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

    const rows = await emailRepository.listEmails(getSession(response), {
      limit: limit + 1,
      gmailLabel: label,
      before,
    });
    const page = rows.slice(0, limit);
    const lastRow = page.at(-1);
    const body: ListEmailsResponse = {
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
