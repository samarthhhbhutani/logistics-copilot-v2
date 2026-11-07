import type { PrismaClient } from '../db/prismaClient.js';

export interface TenantRepository {
  createTenant(name: string): Promise<{ tenantId: string }>;
  tenantExists(tenantId: string): Promise<boolean>;
}

export function createPrismaTenantRepository(prismaClient: PrismaClient): TenantRepository {
  return {
    async createTenant(name) {
      const tenant = await prismaClient.tenant.create({ data: { name }, select: { id: true } });
      return { tenantId: tenant.id };
    },
    async tenantExists(tenantId) {
      const count = await prismaClient.tenant.count({ where: { id: tenantId } });
      return count > 0;
    },
  };
}
