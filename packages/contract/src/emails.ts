import { z } from 'zod';
import { classificationLabelSchema, classificationSourceSchema } from './classificationRules.js';

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

/** The newest label of a mail and who decided it; null when nothing has classified it yet. */
export const currentClassificationSchema = z.object({
  label: classificationLabelSchema,
  source: classificationSourceSchema,
  /** The model's own estimate for llm rows; null for every other source. */
  confidence: z.number().min(0).max(1).nullable(),
  classifiedAt: z.iso.datetime(),
});
export type CurrentClassificationResponse = z.infer<typeof currentClassificationSchema>;

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
  classification: currentClassificationSchema.nullable(),
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

/**
 * POST /v1/mailbox/emails/:emailId/classifications: an operator says what the mail is. Any label,
 * customer_reply included; the "derived only" restriction is on rules and the model, not on people.
 */
export const appendClassificationBodySchema = z.object({ label: classificationLabelSchema });
export type AppendClassificationBody = z.infer<typeof appendClassificationBodySchema>;

/**
 * GET /v1/mailbox/emails/:emailId and each item of a thread. body_text is what the sender typed
 * (signature and, when the thread was already stored, quoted history removed); body_html is as sent.
 */
export const emailDetailSchema = emailSummarySchema.extend({
  ccRecipients: z.array(z.object({ name: z.string(), address: z.string() })),
  rfcMessageId: z.string().nullable(),
  bodyText: z.string(),
  bodyHtml: z.string().nullable(),
});
export type EmailDetailResponse = z.infer<typeof emailDetailSchema>;

/** GET /v1/mailbox/threads/:gmailThreadId: every stored message of the thread, inbox and sent, oldest first. */
export const threadResponseSchema = z.object({
  gmailThreadId: z.string(),
  emails: z.array(emailDetailSchema),
});
export type ThreadResponse = z.infer<typeof threadResponseSchema>;
