import type * as argon2 from 'argon2';

/**
 * Argon2id with a random per-password salt. Parameters (64 MiB, 3 passes, 4 lanes) are encoded in
 * the returned string, so they can be raised later and existing hashes still verify.
 */
const ARGON2_OPTIONS = { memoryCost: 65_536, timeCost: 3, parallelism: 4 } as const;

/**
 * argon2 is a native addon. Loaded on first use so that bundles which only import @lc/core for
 * its repositories (the Lambdas) never run its binary loader; the API pays the import once.
 */
type Argon2Module = typeof argon2;

function loadArgon2(): Promise<Argon2Module> {
  return import('argon2');
}

export async function hashPassword(plainTextPassword: string): Promise<string> {
  const { hash } = await loadArgon2();
  return hash(plainTextPassword, ARGON2_OPTIONS);
}

/** Constant-time comparison inside argon2; a malformed stored hash counts as a mismatch. */
export async function verifyPassword(
  storedPasswordHash: string,
  plainTextPassword: string,
): Promise<boolean> {
  try {
    const { verify } = await loadArgon2();
    return await verify(storedPasswordHash, plainTextPassword);
  } catch {
    return false;
  }
}
