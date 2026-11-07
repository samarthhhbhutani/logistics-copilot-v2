import express from 'express';
import type { Router } from 'express';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { hashPassword } from '@lc/core';
import type { MailboxCredentialsRepository, EncryptionUtil, TenantRepository } from '@lc/core';
import { emailAddressSchema, passwordSchema } from '../auth/authRouter.js';
import { parseRequestBody } from '../http/parseRequestBody.js';

export interface TenantsRouterDependencies {
  tenantRepository: TenantRepository;
  mailboxCredentialsRepository: MailboxCredentialsRepository;
  encryptionUtil: EncryptionUtil;
}

const createTenantBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** The desk's own Google OAuth client (Internal consent screen in their Workspace project). */
  googleClientId: z.string().trim().min(1).max(200),
  googleClientSecret: z.string().trim().min(1).max(200),
});
const createMailboxBodySchema = z.object({ email: emailAddressSchema, password: passwordSchema });
const tenantIdParamsSchema = z.object({ tenantId: z.uuid() });

/**
 * Operator endpoints: POST / creates a tenant (one logistics desk) with its Google OAuth client,
 * secret encrypted at rest; POST /:tenantId/mailboxes
 * creates a mailbox (Gmail connected later by its owner) with its login credentials. Creating an
 * account never signs anyone in; the owner logs in via /v1/auth/login.
 * Open for now; gated by an operator token before the API is public (design doc).
 */
export function createTenantsRouter({
  tenantRepository,
  mailboxCredentialsRepository,
  encryptionUtil,
}: TenantsRouterDependencies): Router {
  const router = express.Router();

  router.post('/', async (request, response) => {
    const body = parseRequestBody(createTenantBodySchema, request.body);
    const tenant = await tenantRepository.createTenant({
      name: body.name,
      googleClientId: body.googleClientId,
      encryptedGoogleClientSecret: encryptionUtil.encryptSecret(body.googleClientSecret),
    });
    response.status(201).json(tenant);
  });

  router.post('/:tenantId/mailboxes', async (request, response) => {
    const { tenantId } = parseRequestBody(tenantIdParamsSchema, request.params);
    const body = parseRequestBody(createMailboxBodySchema, request.body);
    if (!(await tenantRepository.tenantExists(tenantId)))
      throw createHttpError(404, 'tenant_not_found');
    if (await mailboxCredentialsRepository.findMailboxCredentials(body.email)) {
      throw createHttpError(409, 'email_taken');
    }
    const credentials = await mailboxCredentialsRepository.createMailboxCredentials({
      tenantId,
      emailAddress: body.email,
      passwordHash: await hashPassword(body.password),
    });
    response.status(201).json({ mailboxId: credentials.mailboxId, tenantId: credentials.tenantId });
  });

  return router;
}
