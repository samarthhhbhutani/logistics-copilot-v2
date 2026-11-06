import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwordHash.js';

describe('passwordHash', () => {
  it('verifies the original password and rejects others', async () => {
    const storedHash = await hashPassword('correct horse battery staple');
    expect(storedHash.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(storedHash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(storedHash, 'wrong')).resolves.toBe(false);
  });

  it('salts: hashing the same password twice gives different strings', async () => {
    const firstHash = await hashPassword('same password');
    const secondHash = await hashPassword('same password');
    expect(firstHash).not.toBe(secondHash);
  });

  it('treats a malformed stored hash as a mismatch instead of throwing', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });
});
