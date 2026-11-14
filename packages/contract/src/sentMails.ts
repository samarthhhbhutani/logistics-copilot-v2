import { z } from 'zod';

export const MAX_REPLY_TEXT_LENGTH = 20_000;
export const MAX_REPLY_CC_RECIPIENTS = 10;

const recipientSchema = z.object({
  name: z.string().max(200).default(''),
  address: z.email().max(254),
});

/**
 * POST /v1/mailbox/emails/:emailId/replies. `sentMailId` is minted by the client (crypto.randomUUID)
 * so a retried request after a timeout returns the first attempt's row instead of sending twice.
 * Client rule: network error -> retry with the SAME id; 409 sent_mail_id_taken -> mint a NEW id;
 * 502 send_failed -> read sentMail.status (`failed`: new id to try again, `sending`: wait).
 */
export const sendReplyRequestSchema = z.object({
  sentMailId: z.uuid(),
  text: z.string().trim().min(1).max(MAX_REPLY_TEXT_LENGTH),
  cc: z.array(recipientSchema).max(MAX_REPLY_CC_RECIPIENTS).default([]),
});
export type SendReplyRequest = z.infer<typeof sendReplyRequestSchema>;

export const sentMailKindSchema = z.enum(['reply']);
export const sentMailStatusSchema = z.enum(['pending', 'sending', 'sent', 'failed']);
export type SentMailStatus = z.infer<typeof sentMailStatusSchema>;

/** One mail we sent or tried to send. 201 on a fresh send, 200 on an idempotent replay, inside the 502 body on failure. */
export const sentMailResponseSchema = z.object({
  id: z.uuid(),
  kind: sentMailKindSchema,
  status: sentMailStatusSchema,
  inReplyToEmailId: z.uuid().nullable(),
  gmailThreadId: z.string().nullable(),
  rfcMessageId: z.string(),
  toRecipients: z.array(z.object({ name: z.string(), address: z.string() })),
  ccRecipients: z.array(z.object({ name: z.string(), address: z.string() })),
  subject: z.string(),
  bodyText: z.string(),
  gmailMessageId: z.string().nullable(),
  /** GmailApiError code when status is failed; null otherwise. */
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SentMailResponse = z.infer<typeof sentMailResponseSchema>;

/** 502 from the reply endpoint: Gmail refused the send; the row is kept as failed for a retry. */
export const sendReplyFailedResponseSchema = z.object({
  error: z.literal('send_failed'),
  sentMail: sentMailResponseSchema,
});
export type SendReplyFailedResponse = z.infer<typeof sendReplyFailedResponseSchema>;
