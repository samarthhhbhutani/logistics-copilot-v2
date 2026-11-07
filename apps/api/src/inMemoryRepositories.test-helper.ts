import { randomUUID } from 'node:crypto';
import type { MailboxCredentials, MailboxCredentialsRepository, TenantRepository } from '@lc/core';

/** Test doubles with the same contracts as the Prisma repositories, no database. */
export function createInMemoryRepositories(): {
  tenantRepository: TenantRepository;
  mailboxCredentialsRepository: MailboxCredentialsRepository;
} {
  const tenantIds = new Set<string>();
  const credentialsByEmail = new Map<string, MailboxCredentials>();
  return {
    tenantRepository: {
      async createTenant() {
        const tenantId = randomUUID();
        tenantIds.add(tenantId);
        return { tenantId };
      },
      async tenantExists(tenantId) {
        return tenantIds.has(tenantId);
      },
    },
    mailboxCredentialsRepository: {
      async findMailboxCredentials(emailAddress) {
        return credentialsByEmail.get(emailAddress);
      },
      async createMailboxCredentials({ tenantId, emailAddress, passwordHash }) {
        const credentials = { mailboxId: randomUUID(), tenantId, passwordHash };
        credentialsByEmail.set(emailAddress, credentials);
        return credentials;
      },
    },
  };
}
