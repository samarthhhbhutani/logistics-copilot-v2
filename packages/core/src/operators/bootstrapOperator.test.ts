import { describe, expect, it } from 'vitest';
import { verifyPassword } from '../auth/passwordHash.js';
import { bootstrapOperator } from './bootstrapOperator.js';
import type { OperatorCredentials, OperatorRepository } from './operatorRepository.js';

function createInMemoryOperatorRepository(): OperatorRepository & { rows: OperatorCredentials[] } {
  const rows: OperatorCredentials[] = [];
  return {
    rows,
    async findOperatorByEmail(email) {
      return rows.find((row) => row.email === email);
    },
    async upsertOperator({ email, passwordHash }) {
      const existing = rows.find((row) => row.email === email);
      if (existing) {
        existing.passwordHash = passwordHash;
        return existing;
      }
      const created = { operatorId: `operator-${rows.length + 1}`, email, passwordHash };
      rows.push(created);
      return created;
    },
  };
}

describe('bootstrapOperator', () => {
  it('stores the email lowercased with an argon2id hash, never the password', async () => {
    const repository = createInMemoryOperatorRepository();
    const operator = await bootstrapOperator(
      { email: 'Ops@Example.com', password: 'correct horse battery' },
      repository,
    );
    expect(operator).toEqual({ operatorId: 'operator-1', email: 'ops@example.com' });
    expect(repository.rows[0].passwordHash).not.toContain('correct horse battery');
    expect(await verifyPassword(repository.rows[0].passwordHash, 'correct horse battery')).toBe(
      true,
    );
  });

  it('running it again for the same email resets the password instead of adding a row', async () => {
    const repository = createInMemoryOperatorRepository();
    await bootstrapOperator({ email: 'ops@example.com', password: 'first password 1' }, repository);
    await bootstrapOperator({ email: 'ops@example.com', password: 'second password' }, repository);
    expect(repository.rows).toHaveLength(1);
    expect(await verifyPassword(repository.rows[0].passwordHash, 'first password 1')).toBe(false);
    expect(await verifyPassword(repository.rows[0].passwordHash, 'second password')).toBe(true);
  });

  it('rejects a short password or a non-email before touching the repository', async () => {
    const repository = createInMemoryOperatorRepository();
    await expect(
      bootstrapOperator({ email: 'ops@example.com', password: 'tiny' }, repository),
    ).rejects.toThrow();
    await expect(
      bootstrapOperator({ email: 'not-an-email', password: 'long enough password' }, repository),
    ).rejects.toThrow();
    expect(repository.rows).toHaveLength(0);
  });
});
