import { hash, verify } from 'argon2';

/**
 * Argon2id with a random per-password salt. Parameters (64 MiB, 3 passes, 4 lanes) are encoded in
 * the returned string, so they can be raised later and existing hashes still verify.
 */
const ARGON2_OPTIONS = { memoryCost: 65_536, timeCost: 3, parallelism: 4 } as const;

export function hashPassword(plainTextPassword: string): Promise<string> {
  return hash(plainTextPassword, ARGON2_OPTIONS);
}

/** Constant-time comparison inside argon2; a malformed stored hash counts as a mismatch. */
export async function verifyPassword(
  storedPasswordHash: string,
  plainTextPassword: string,
): Promise<boolean> {
  try {
    return await verify(storedPasswordHash, plainTextPassword);
  } catch {
    return false;
  }
}
