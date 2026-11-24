import express from 'express';
import type { Router } from 'express';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { hashPassword } from '@lc/core';
import type { MailboxCredentialsRepository, EncryptionUtil, TenantRepository } from '@lc/core';
import { createMailboxRequestSchema, createTenantRequestSchema } from '@lc/contract';
import { parseRequestBody } from '../http/parseRequestBody.js';

export interface TenantsRouterDependencies {
  tenantRepository: TenantRepository;
  mailboxCredentialsRepository: MailboxCredentialsRepository;
  encryptionUtil: EncryptionUtil;
}

const tenantIdParamsSchema = z.object({ tenantId: z.uuid() });

/**
 * Operator endpoints: POST / creates a tenant (one logistics desk) with its Google OAuth client,
 * secret encrypted at rest, and its Pub/Sub topic and push service account; POST /:tenantId/mailboxes
 * creates a mailbox (Gmail connected later by its owner) with its login credentials. Creating an
 * account never signs anyone in; the owner logs in via /v1/auth/login. Mounted behind
 * requireOperator in createAppInstance.
 */
export function createTenantsRouter({
  tenantRepository,
  mailboxCredentialsRepository,
  encryptionUtil,
}: TenantsRouterDependencies): Router {
  const router = express.Router();

  router.post('/', async (request, response) => {
    const body = parseRequestBody(createTenantRequestSchema, request.body);
    const tenant = await tenantRepository.createTenant({
      name: body.name,
      googleClientId: body.googleClientId,
      encryptedGoogleClientSecret: encryptionUtil.encryptSecret(body.googleClientSecret),
      pubsubTopicName: body.pubsubTopicName,
      pushServiceAccountEmail: body.pushServiceAccountEmail,
    });
    response.status(201).json(tenant);
  });

  router.post('/:tenantId/mailboxes', async (request, response) => {
    const { tenantId } = parseRequestBody(tenantIdParamsSchema, request.params);
    const body = parseRequestBody(createMailboxRequestSchema, request.body);
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
