import { describe, expect, it } from 'vitest';
import { Prisma } from '../db/generated/client.js';
import type { PrismaClient } from '../db/prismaClient.js';
import {
  MAX_CLASSIFICATION_RULES_PER_TENANT,
  createPrismaClassificationRuleRepository,
} from './classificationRuleRepository.js';

const ruleRow = {
  id: '00000000-0000-4000-8000-000000000001',
  priority: 10,
  senderPattern: 'acme.com',
  label: 'CUSTOMER_REQUEST' as const,
  enabled: true,
  createdAt: new Date('2026-11-01T00:00:00Z'),
};

/** Records every call so the tests can assert the tenant filter and ordering of the real queries. */
function createPrismaStub(options: { ruleCount?: number; createError?: Error } = {}) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const prismaClient = {
    classificationRule: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ method: 'findMany', args });
        return [ruleRow];
      },
      count: async (args: Record<string, unknown>) => {
        calls.push({ method: 'count', args });
        return options.ruleCount ?? 0;
      },
      create: async (args: Record<string, unknown>) => {
        calls.push({ method: 'create', args });
        if (options.createError) throw options.createError;
        return ruleRow;
      },
    },
  } as unknown as PrismaClient;
  return { prismaClient, calls };
}

const expectedOrder = [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];

describe('createPrismaClassificationRuleRepository', () => {
  it('lists enabled rules of the tenant only, in priority order, as snake_case labels', async () => {
    const { prismaClient, calls } = createPrismaStub();

    const rules =
      await createPrismaClassificationRuleRepository(prismaClient).listEnabledRules('tenant-1');

    expect(calls[0]!.args).toMatchObject({
      where: { tenantId: 'tenant-1', enabled: true },
      orderBy: expectedOrder,
    });
    expect(rules).toEqual([{ ...ruleRow, label: 'customer_request' }]);
  });

  it('lists every rule of the tenant, disabled included', async () => {
    const { prismaClient, calls } = createPrismaStub();

    await createPrismaClassificationRuleRepository(prismaClient).listRules('tenant-1');

    expect(calls[0]!.args).toMatchObject({
      where: { tenantId: 'tenant-1' },
      orderBy: expectedOrder,
    });
  });

  it('creates under the given tenant and returns the stored rule', async () => {
    const { prismaClient, calls } = createPrismaStub();

    const result = await createPrismaClassificationRuleRepository(prismaClient).createRule(
      'tenant-1',
      { senderPattern: 'acme.com', label: 'customer_request', priority: 10 },
    );

    expect(result).toEqual({ outcome: 'created', rule: { ...ruleRow, label: 'customer_request' } });
    expect(calls.map((call) => call.method)).toEqual(['count', 'create']);
    expect(calls[0]!.args).toEqual({ where: { tenantId: 'tenant-1' } });
    expect(calls[1]!.args).toMatchObject({
      data: {
        tenantId: 'tenant-1',
        senderPattern: 'acme.com',
        label: 'CUSTOMER_REQUEST',
        priority: 10,
      },
    });
  });

  it('reports a duplicate pattern from the unique index and rethrows anything else', async () => {
    const uniqueViolation = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const duplicate = await createPrismaClassificationRuleRepository(
      createPrismaStub({ createError: uniqueViolation }).prismaClient,
    ).createRule('tenant-1', { senderPattern: 'acme.com', label: 'general', priority: 1 });
    expect(duplicate).toEqual({ outcome: 'duplicate_pattern' });

    await expect(
      createPrismaClassificationRuleRepository(
        createPrismaStub({ createError: new Error('connection reset') }).prismaClient,
      ).createRule('tenant-1', { senderPattern: 'acme.com', label: 'general', priority: 1 }),
    ).rejects.toThrow('connection reset');
  });

  it('refuses to create past the per-tenant cap without touching the table', async () => {
    const { prismaClient, calls } = createPrismaStub({
      ruleCount: MAX_CLASSIFICATION_RULES_PER_TENANT,
    });

    const result = await createPrismaClassificationRuleRepository(prismaClient).createRule(
      'tenant-1',
      { senderPattern: 'acme.com', label: 'general', priority: 1 },
    );

    expect(result).toEqual({ outcome: 'too_many_rules' });
    expect(calls.map((call) => call.method)).toEqual(['count']);
  });
});
