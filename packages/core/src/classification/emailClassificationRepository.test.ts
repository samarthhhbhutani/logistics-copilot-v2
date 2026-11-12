import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaEmailClassificationRepository } from './emailClassificationRepository.js';

const scope = { mailboxId: 'mailbox-1', tenantId: 'tenant-1' };
const classifiedAt = new Date('2026-11-11T09:00:00Z');

/** email.findFirst answers from the script; classification.create echoes its data and records both calls. */
function stubPrisma(email: { gmailLabel: 'INBOX' | 'SENT' } | null) {
  const calls: { model: string; args: Record<string, unknown> }[] = [];
  const prismaClient = {
    email: {
      async findFirst(args: Record<string, unknown>) {
        calls.push({ model: 'email', args });
        return email;
      },
    },
    classification: {
      async create(args: { data: { label: string; source: string } }) {
        calls.push({ model: 'classification', args });
        return { label: args.data.label, source: args.data.source, confidence: null, classifiedAt };
      },
    },
  } as unknown as PrismaClient;
  return { prismaClient, calls };
}

describe('appendUserClassification', () => {
  it('checks the email inside the scope, then appends a USER row with only the label', async () => {
    const { prismaClient, calls } = stubPrisma({ gmailLabel: 'INBOX' });

    const result = await createPrismaEmailClassificationRepository(
      prismaClient,
    ).appendUserClassification(scope, 'email-1', 'rate_card');

    expect(result).toEqual({
      outcome: 'appended',
      classification: { label: 'rate_card', source: 'user', confidence: null, classifiedAt },
    });
    expect(calls[0]?.args.where).toEqual({ id: 'email-1', ...scope });
    expect(calls[1]?.args.data).toEqual({
      tenantId: 'tenant-1',
      emailId: 'email-1',
      label: 'RATE_CARD',
      source: 'USER',
    });
  });

  it('appends again when the label equals the current one: a confirmation is recorded, not skipped', async () => {
    const { prismaClient, calls } = stubPrisma({ gmailLabel: 'INBOX' });
    const repository = createPrismaEmailClassificationRepository(prismaClient);

    await repository.appendUserClassification(scope, 'email-1', 'general');
    await repository.appendUserClassification(scope, 'email-1', 'general');

    expect(calls.map((call) => call.model)).toEqual([
      'email',
      'classification',
      'email',
      'classification',
    ]);
  });

  it('reports not_found without writing when the email is outside the scope', async () => {
    const { prismaClient, calls } = stubPrisma(null);

    const result = await createPrismaEmailClassificationRepository(
      prismaClient,
    ).appendUserClassification(scope, 'email-9', 'general');

    expect(result).toEqual({ outcome: 'not_found' });
    expect(calls.map((call) => call.model)).toEqual(['email']);
  });

  it('reports not_inbound without writing for a SENT mail', async () => {
    const { prismaClient, calls } = stubPrisma({ gmailLabel: 'SENT' });

    const result = await createPrismaEmailClassificationRepository(
      prismaClient,
    ).appendUserClassification(scope, 'email-1', 'general');

    expect(result).toEqual({ outcome: 'not_inbound' });
    expect(calls.map((call) => call.model)).toEqual(['email']);
  });
});
