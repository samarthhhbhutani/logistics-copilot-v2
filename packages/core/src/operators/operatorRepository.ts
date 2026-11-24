import type { PrismaClient } from '../db/prismaClient.js';

/** An operator's identity plus the hash a typed password is checked against. */
export interface OperatorCredentials {
  operatorId: string;
  email: string;
  passwordHash: string;
}

/**
 * Persistence for operator login. The API depends on this interface so route tests run against an
 * in-memory implementation; production wires createPrismaOperatorRepository.
 */
export interface OperatorRepository {
  findOperatorByEmail(email: string): Promise<OperatorCredentials | undefined>;
  /** Creates the operator, or replaces the password hash when the email already exists. */
  upsertOperator(input: { email: string; passwordHash: string }): Promise<OperatorCredentials>;
}

const operatorCredentialsSelect = { id: true, email: true, passwordHash: true } as const;

function toOperatorCredentials(row: {
  id: string;
  email: string;
  passwordHash: string;
}): OperatorCredentials {
  return { operatorId: row.id, email: row.email, passwordHash: row.passwordHash };
}

export function createPrismaOperatorRepository(prismaClient: PrismaClient): OperatorRepository {
  return {
    async findOperatorByEmail(email) {
      const row = await prismaClient.operator.findUnique({
        where: { email },
        select: operatorCredentialsSelect,
      });
      return row ? toOperatorCredentials(row) : undefined;
    },

    async upsertOperator({ email, passwordHash }) {
      const row = await prismaClient.operator.upsert({
        where: { email },
        create: { email, passwordHash },
        update: { passwordHash },
        select: operatorCredentialsSelect,
      });
      return toOperatorCredentials(row);
    },
  };
}
