import type { PrismaClient } from '../db/prismaClient.js';

/** A mailbox's identity plus the hash a typed password is checked against. */
export interface MailboxCredentials {
  mailboxId: string;
  tenantId: string;
  passwordHash: string;
}

export interface CreateMailboxCredentialsInput {
  tenantId: string;
  emailAddress: string;
  passwordHash: string;
}

/**
 * Persistence for login. The API depends on this interface so route tests run against an in-memory
 * implementation; production wires createPrismaMailboxCredentialsRepository.
 */
export interface MailboxCredentialsRepository {
  findMailboxCredentials(emailAddress: string): Promise<MailboxCredentials | undefined>;
  /** Creates the mailbox (Gmail not yet connected) and its credentials row together. */
  createMailboxCredentials(input: CreateMailboxCredentialsInput): Promise<MailboxCredentials>;
}

const mailboxCredentialsSelect = { mailboxId: true, tenantId: true, passwordHash: true } as const;

export function createPrismaMailboxCredentialsRepository(
  prismaClient: PrismaClient,
): MailboxCredentialsRepository {
  return {
    async findMailboxCredentials(emailAddress) {
      const credentials = await prismaClient.mailboxLogin.findFirst({
        where: { mailbox: { emailAddress } },
        select: mailboxCredentialsSelect,
      });
      return credentials ?? undefined;
    },

    async createMailboxCredentials({ tenantId, emailAddress, passwordHash }) {
      const mailbox = await prismaClient.mailbox.create({
        data: { tenantId, emailAddress, login: { create: { tenantId, passwordHash } } },
        select: { login: { select: mailboxCredentialsSelect } },
      });
      if (!mailbox.login) throw new Error('mailbox created without its credentials');
      return mailbox.login;
    },
  };
}
