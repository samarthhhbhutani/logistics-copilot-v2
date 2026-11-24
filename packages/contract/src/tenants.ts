import { z } from 'zod';
import { emailAddressSchema, passwordSchema } from './auth.js';

/** `projects/<project id>/topics/<topic>`: project ids are 6-30 lowercase letters, digits, hyphens. */
const pubsubTopicNamePattern =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][\w.~+%-]{2,254}$/;
const serviceAccountEmailPattern =
  /^[a-z][a-z0-9-]{5,29}@[a-z][a-z0-9-]{4,29}\.iam\.gserviceaccount\.com$/;

/** POST /v1/tenants: one logistics desk with its own Google OAuth client and Pub/Sub push setup. */
export const createTenantRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** The desk's own Google OAuth client (Internal consent screen in their Workspace project). */
  googleClientId: z.string().trim().min(1).max(200),
  googleClientSecret: z.string().trim().min(1).max(200),
  /**
   * Pub/Sub topic Gmail publishes to, in the same project as the OAuth client (docs/clientOnboarding
   * part C). Only the shape is checked here; a wrong project surfaces when users.watch is called.
   */
  pubsubTopicName: z
    .string()
    .trim()
    .regex(pubsubTopicNamePattern, 'expected projects/<project>/topics/<topic>'),
  /** Service account the tenant's push subscription authenticates as. */
  pushServiceAccountEmail: z
    .string()
    .trim()
    .toLowerCase()
    .regex(serviceAccountEmailPattern, 'expected <name>@<project>.iam.gserviceaccount.com'),
});
export type CreateTenantRequest = z.input<typeof createTenantRequestSchema>;
export const tenantCreatedResponseSchema = z.object({ tenantId: z.uuid() });
export type TenantCreatedResponse = z.infer<typeof tenantCreatedResponseSchema>;

/** POST /v1/tenants/:tenantId/mailboxes: a mailbox (Gmail connected later by its owner) and its login. */
export const createMailboxRequestSchema = z.object({
  email: emailAddressSchema,
  password: passwordSchema,
});
export type CreateMailboxRequest = z.input<typeof createMailboxRequestSchema>;
export const mailboxCreatedResponseSchema = z.object({ mailboxId: z.uuid(), tenantId: z.uuid() });
export type MailboxCreatedResponse = z.infer<typeof mailboxCreatedResponseSchema>;
