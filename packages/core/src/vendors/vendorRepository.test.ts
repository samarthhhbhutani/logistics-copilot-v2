import { describe, expect, it } from 'vitest';
import { Prisma } from '../db/generated/client.js';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaVendorRepository } from './vendorRepository.js';

const tenantId = 'tenant-1';
const vendorId = '00000000-0000-4000-8000-000000000001';
const contactId = '00000000-0000-4000-8000-000000000002';
const now = new Date('2026-11-14T12:00:00Z');
const vendorRow = {
  id: vendorId,
  vendorName: 'Sea Lines',
  category: 'CARRIER',
  notes: null,
  active: true,
  createdAt: now,
  updatedAt: now,
  contacts: [],
};

function prismaError(code: 'P2002' | 'P2025') {
  return new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: 'test' });
}

/** Records every vendor.update / vendor.findFirst call; `updateOutcome` is the row returned or the error thrown. */
function stubVendorClient(
  options: { updateOutcome?: unknown; candidateRows?: { id: string }[] } = {},
) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const prismaClient = {
    vendor: {
      async findMany(args: Record<string, unknown>) {
        calls.push({ method: 'findMany', args });
        return options.candidateRows ?? [];
      },
      async update(args: Record<string, unknown>) {
        calls.push({ method: 'update', args });
        if (options.updateOutcome instanceof Error) throw options.updateOutcome;
        return options.updateOutcome ?? vendorRow;
      },
    },
  } as unknown as PrismaClient;
  return { prismaClient, calls };
}

describe('updateVendor', () => {
  it('is one UPDATE keyed by id and tenant, returning the vendor with contacts, and skips the name check when no name is set', async () => {
    const { prismaClient, calls } = stubVendorClient();
    const result = await createPrismaVendorRepository(prismaClient).updateVendor(
      tenantId,
      vendorId,
      {
        category: 'cha',
        active: false,
      },
    );
    expect(result).toMatchObject({
      outcome: 'updated',
      vendor: { id: vendorId, category: 'carrier' },
    });
    expect(calls.map((call) => call.method)).toEqual(['update']);
    expect(calls[0]?.args.where).toEqual({ id: vendorId, tenantId });
    expect(calls[0]?.args.data).toEqual({ category: 'CHA', active: false });
  });

  it('on a rename, one query decides existence first and then the case-insensitive name clash', async () => {
    const rename = (candidateRows: { id: string }[]) => {
      const stub = stubVendorClient({ candidateRows });
      return createPrismaVendorRepository(stub.prismaClient)
        .updateVendor(tenantId, vendorId, { vendorName: 'clear customs' })
        .then((result) => ({ result, calls: stub.calls }));
    };

    const unknownId = await rename([{ id: 'other' }]);
    expect(unknownId.result, 'unknown id with a clashing name is not found, not taken').toEqual({
      outcome: 'vendor_not_found',
    });
    expect(unknownId.calls.map((call) => call.method)).toEqual(['findMany']);
    expect(unknownId.calls[0]?.args.where).toEqual({
      tenantId,
      OR: [{ id: vendorId }, { vendorName: { equals: 'clear customs', mode: 'insensitive' } }],
    });

    const clash = await rename([{ id: vendorId }, { id: 'other' }]);
    expect(clash.result).toEqual({ outcome: 'vendor_name_taken' });
    expect(clash.calls.map((call) => call.method)).toEqual(['findMany']);

    const respelling = await rename([{ id: vendorId }]);
    expect(respelling.result).toMatchObject({ outcome: 'updated' });
    expect(respelling.calls.map((call) => call.method)).toEqual(['findMany', 'update']);
  });

  it('maps a missed WHERE to vendor_not_found and a unique hit to vendor_name_taken, rethrowing anything else', async () => {
    const repository = (outcome: unknown) =>
      createPrismaVendorRepository(stubVendorClient({ updateOutcome: outcome }).prismaClient);
    expect(
      await repository(prismaError('P2025')).updateVendor(tenantId, vendorId, { notes: 'x' }),
    ).toEqual({
      outcome: 'vendor_not_found',
    });
    expect(
      await repository(prismaError('P2002')).updateVendor(tenantId, vendorId, { notes: 'x' }),
    ).toEqual({
      outcome: 'vendor_name_taken',
    });
    await expect(
      repository(new Error('connection reset')).updateVendor(tenantId, vendorId, { notes: 'x' }),
    ).rejects.toThrow('connection reset');
  });
});

describe('addContact and updateContact', () => {
  const contact = { contactName: 'Priya', emailAddress: 'priya@sealines.com', phoneNumber: null };

  it('write through the parent vendor so one statement checks the tenant and returns all contacts', async () => {
    const { prismaClient, calls } = stubVendorClient();
    const repository = createPrismaVendorRepository(prismaClient);

    await repository.addContact(tenantId, vendorId, contact);
    await repository.updateContact(tenantId, vendorId, contactId, { active: false });

    expect(calls.map((call) => call.method)).toEqual(['update', 'update']);
    expect(calls[0]?.args.where).toEqual({ id: vendorId, tenantId });
    expect(calls[0]?.args.data).toEqual({ contacts: { create: { tenantId, ...contact } } });
    expect(calls[1]?.args.where).toEqual({ id: vendorId, tenantId });
    expect(calls[1]?.args.data).toEqual({
      contacts: { update: { where: { id: contactId }, data: { active: false } } },
    });
  });

  it('map P2025 to the missing parent or contact and P2002 to contact_email_taken', async () => {
    const repository = (outcome: unknown) =>
      createPrismaVendorRepository(stubVendorClient({ updateOutcome: outcome }).prismaClient);
    expect(await repository(prismaError('P2025')).addContact(tenantId, vendorId, contact)).toEqual({
      outcome: 'vendor_not_found',
    });
    expect(await repository(prismaError('P2002')).addContact(tenantId, vendorId, contact)).toEqual({
      outcome: 'contact_email_taken',
    });
    expect(
      await repository(prismaError('P2025')).updateContact(tenantId, vendorId, contactId, {
        active: false,
      }),
    ).toEqual({ outcome: 'contact_not_found' });
    expect(
      await repository(prismaError('P2002')).updateContact(tenantId, vendorId, contactId, {
        emailAddress: 'arjun@sealines.com',
      }),
    ).toEqual({ outcome: 'contact_email_taken' });
  });
});
