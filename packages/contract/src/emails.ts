import { z } from 'zod';

export const DEFAULT_EMAIL_PAGE_SIZE = 50;
export const MAX_EMAIL_PAGE_SIZE = 100;

export const gmailLabelSchema = z.enum(['inbox', 'sent']);
export type GmailLabel = z.infer<typeof gmailLabelSchema>;

/** GET /v1/mailbox/emails ?limit=50&cursor=<opaque>&label=inbox|sent */
export const listEmailsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_EMAIL_PAGE_SIZE).default(DEFAULT_EMAIL_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
  label: gmailLabelSchema.optional(),
});

/** One list row: dates as ISO strings, sender folded into one object, email null when From was missing. */
export const emailSummarySchema = z.object({
  id: z.uuid(),
  gmailThreadId: z.string(),
  gmailLabel: gmailLabelSchema,
  sender: z.object({ name: z.string(), email: z.string().nullable() }),
  toRecipients: z.array(z.object({ name: z.string(), address: z.string() })),
  subject: z.string(),
  snippet: z.string(),
  receivedAt: z.iso.datetime(),
});
export type EmailSummaryResponse = z.infer<typeof emailSummarySchema>;

export const listEmailsResponseSchema = z.object({
  /** Identity of the cookie used for this response, so tabs can reject an account switch. */
  mailboxId: z.uuid(),
  tenantId: z.uuid(),
  emails: z.array(emailSummarySchema),
  /** Pass back as ?cursor= for the next page; null when this was the last page. */
  nextCursor: z.string().nullable(),
});
export type ListEmailsResponse = z.infer<typeof listEmailsResponseSchema>;
