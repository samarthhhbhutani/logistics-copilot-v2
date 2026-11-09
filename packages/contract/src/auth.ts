import { z } from 'zod';

export const emailAddressSchema = z
  .email()
  .max(254)
  .transform((emailAddress) => emailAddress.toLowerCase());
export const passwordSchema = z.string().min(6).max(256);

export const loginRequestSchema = z.object({ email: emailAddressSchema, password: passwordSchema });

/** What POST /v1/auth/login and GET /v1/me return: the signed-in mailbox and its tenant. */
export const sessionResponseSchema = z.object({ mailboxId: z.uuid(), tenantId: z.uuid() });
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
