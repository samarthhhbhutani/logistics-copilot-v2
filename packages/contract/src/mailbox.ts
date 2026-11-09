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
});
export type MailboxResponse = z.infer<typeof mailboxResponseSchema>;

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
