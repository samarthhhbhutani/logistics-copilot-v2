import { z } from 'zod';

export const gmailConnectionStatusSchema = z.enum([
  'not_connected',
  'connected',
  'needs_reconnect',
]);
export type GmailConnectionStatus = z.infer<typeof gmailConnectionStatusSchema>;

/** GET /v1/mailbox: the signed-in mailbox's address and Gmail connection state. */
export const mailboxResponseSchema = z.object({
  mailboxId: z.uuid(),
  tenantId: z.uuid(),
  emailAddress: z.string(),
  gmailConnectionStatus: gmailConnectionStatusSchema,
  gmailConnectedAt: z.iso.datetime().nullable(),
  watchExpiresAt: z.iso.datetime().nullable(),
  /** Plain text appended to every mail sent from this mailbox; derived from signatureHtml. Null when none is set. */
  signature: z.string().nullable(),
  /** The sanitised HTML signature as stored; null when none is set. */
  signatureHtml: z.string().nullable(),
});
export type MailboxResponse = z.infer<typeof mailboxResponseSchema>;

/** Longest plain-text signature we send; the HTML is derived to text and checked against this. */
export const MAILBOX_SIGNATURE_MAX_LENGTH = 2000;
/** Longest HTML signature accepted before sanitising; tables and inline styles are verbose. */
export const MAILBOX_SIGNATURE_HTML_MAX_LENGTH = 20_000;

/**
 * PATCH /v1/mailbox/signature. HTML; it is sanitised server-side and the text signature is derived
 * from it. Null, or HTML with nothing visible left after sanitising, clears both. Responds with MailboxResponse.
 */
export const updateMailboxSignatureRequestSchema = z.object({
  signatureHtml: z.string().max(MAILBOX_SIGNATURE_HTML_MAX_LENGTH).nullable(),
});
export type UpdateMailboxSignatureRequest = z.infer<typeof updateMailboxSignatureRequestSchema>;

const GOOGLE_OAUTH_URL_PREFIX = 'https://accounts.google.com/o/oauth2/';

/**
 * POST /v1/mailbox/gmail/connect. The frontend assigns this to window.location, so anything other
 * than Google's consent screen is refused rather than followed.
 */
export const gmailConnectResponseSchema = z.object({
  url: z
    .url({ protocol: /^https$/, hostname: /^accounts\.google\.com$/ })
    .startsWith(GOOGLE_OAUTH_URL_PREFIX, 'expected a Google OAuth consent URL'),
});
export type GmailConnectResponse = z.infer<typeof gmailConnectResponseSchema>;

/** Why a connect attempt did not end in a saved token; the frontend's failed screen keys on it. */
export const connectFlowErrorSchema = z.enum([
  'denied',
  'invalid_state',
  'google_client_not_configured',
  'exchange_failed',
  'email_mismatch',
  'scope_not_granted',
  // The tenant has no Pub/Sub topic or push service account on file (docs/clientOnboarding, part C).
  'pubsub_not_configured',
  // users.watch refused the tenant's topic: wrong project or missing Publisher grant.
  'watch_failed',
]);
export type ConnectFlowErrorCode = z.infer<typeof connectFlowErrorSchema>;
