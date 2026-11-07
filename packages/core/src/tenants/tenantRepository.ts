import type { PrismaClient } from '../db/prismaClient.js';

export interface CreateTenantInput {
  name: string;
  /** The desk's own Google OAuth client; the secret arrives already encrypted (createEncryptionUtil). */
  googleClientId: string;
  encryptedGoogleClientSecret: string;
  /** Where Gmail publishes change notifications for this tenant's mailboxes; same project as the client. */
  pubsubTopicName: string;
  /** Identity the tenant's push subscription signs deliveries with. */
  pushServiceAccountEmail: string;
}

export interface TenantGoogleClient {
  clientId: string;
  encryptedClientSecret: string;
}

export interface TenantPubsubPush {
  topicName: string;
  pushServiceAccountEmail: string;
}

export interface TenantRepository {
  createTenant(input: CreateTenantInput): Promise<{ tenantId: string }>;
  tenantExists(tenantId: string): Promise<boolean>;
  /** Undefined when the tenant is missing or predates per-tenant clients (columns null). */
  findTenantGoogleClient(tenantId: string): Promise<TenantGoogleClient | undefined>;
  /** Undefined when the tenant is missing or predates Pub/Sub onboarding (columns null). */
  findTenantPubsubPush(tenantId: string): Promise<TenantPubsubPush | undefined>;
}

export function createPrismaTenantRepository(prismaClient: PrismaClient): TenantRepository {
  return {
    async createTenant({
      name,
      googleClientId,
      encryptedGoogleClientSecret,
      pubsubTopicName,
      pushServiceAccountEmail,
    }) {
      const tenant = await prismaClient.tenant.create({
        data: {
          name,
          googleClientId,
          encryptedGoogleClientSecret,
          pubsubTopicName,
          pushServiceAccountEmail,
        },
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
    async findTenantPubsubPush(tenantId) {
      const tenant = await prismaClient.tenant.findUnique({
        where: { id: tenantId },
        select: { pubsubTopicName: true, pushServiceAccountEmail: true },
      });
      if (!tenant?.pubsubTopicName || !tenant.pushServiceAccountEmail) return undefined;
      return {
        topicName: tenant.pubsubTopicName,
        pushServiceAccountEmail: tenant.pushServiceAccountEmail,
      };
    },
  };
}
