import type { PrismaClient } from '../db/prismaClient.js';

export interface CreateTenantInput {
  name: string;
  /** The desk's own Google OAuth client; the secret arrives already encrypted (createEncryptionUtil). */
  googleClientId: string;
  encryptedGoogleClientSecret: string;
}

export interface TenantGoogleClient {
  clientId: string;
  encryptedClientSecret: string;
}

export interface TenantRepository {
  createTenant(input: CreateTenantInput): Promise<{ tenantId: string }>;
  tenantExists(tenantId: string): Promise<boolean>;
  /** Undefined when the tenant is missing or predates per-tenant clients (columns null). */
  findTenantGoogleClient(tenantId: string): Promise<TenantGoogleClient | undefined>;
}

export function createPrismaTenantRepository(prismaClient: PrismaClient): TenantRepository {
  return {
    async createTenant({ name, googleClientId, encryptedGoogleClientSecret }) {
      const tenant = await prismaClient.tenant.create({
        data: { name, googleClientId, encryptedGoogleClientSecret },
        select: { id: true },
      });
      return { tenantId: tenant.id };
    },
    async tenantExists(tenantId) {
      const count = await prismaClient.tenant.count({ where: { id: tenantId } });
      return count > 0;
    },
    async findTenantGoogleClient(tenantId) {
      const tenant = await prismaClient.tenant.findUnique({
        where: { id: tenantId },
        select: { googleClientId: true, encryptedGoogleClientSecret: true },
      });
      if (!tenant?.googleClientId || !tenant.encryptedGoogleClientSecret) return undefined;
      return {
        clientId: tenant.googleClientId,
        encryptedClientSecret: tenant.encryptedGoogleClientSecret,
      };
    },
  };
}
