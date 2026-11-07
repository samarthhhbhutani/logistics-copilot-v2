import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts short secrets (Gmail refresh tokens, per-tenant OAuth client secrets) before they are
 * written to Postgres, so a database dump alone is not enough to read mailboxes.
 *
 * Ciphertext format: `v1.<initializationVector>.<ciphertext>.<authTag>`, every part base64url.
 * The `v1` prefix is also the GCM additional authenticated data, so a future `v2` can rotate the
 * algorithm or key and `decryptSecret` can tell old rows from new ones without guessing.
 */
export interface EncryptionUtil {
  encryptSecret(plaintext: string): string;
  decryptSecret(ciphertext: string): string;
}

export class SecretDecryptionError extends Error {
  constructor(reason: string) {
    super(`Cannot decrypt secret: ${reason}`);
    this.name = 'SecretDecryptionError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const INITIALIZATION_VECTOR_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const FORMAT_VERSION = 'v1';

/**
 * @param encryptionKeyBase64 the 32-byte key as standard base64 (`openssl rand -base64 32`),
 *   i.e. `Config.TOKEN_ENCRYPTION_KEY`. Throws at construction, so a bad key fails the process at
 *   startup instead of on the first write.
 */
export function createEncryptionUtil(encryptionKeyBase64: string): EncryptionUtil {
  const encryptionKey = Buffer.from(encryptionKeyBase64, 'base64');
  if (encryptionKey.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_LENGTH_BYTES} bytes, got ${encryptionKey.length}`,
    );
  }

  return {
    encryptSecret(plaintext) {
      // Fresh random initialization vector per call: the same plaintext never encrypts to the same
      // bytes twice, and GCM is only safe while a key + vector pair is never reused.
      const initializationVector = randomBytes(INITIALIZATION_VECTOR_LENGTH_BYTES);
      // A one-shot encryptor bound to our key and this vector. It does no work yet; update()/final()
      // stream bytes through it and getAuthTag() reads the integrity seal once it is closed.
      const cipher = createCipheriv(ALGORITHM, encryptionKey, initializationVector, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      // Not encrypted, but covered by the auth tag: editing the stored "v1" breaks decryption.
      cipher.setAAD(Buffer.from(FORMAT_VERSION));
      // update() is where the plaintext is actually encrypted with the key and vector set above;
      // final() flushes and completes the tag computation (empty output for GCM, still required).
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return [
        FORMAT_VERSION,
        initializationVector.toString('base64url'),
        encrypted.toString('base64url'),
        authTag.toString('base64url'),
      ].join('.');
    },

    decryptSecret(ciphertext) {
      const parts = ciphertext.split('.');
      if (parts.length !== 4) throw new SecretDecryptionError('expected 4 dot-separated parts');
      const [version, initializationVectorBase64url, encryptedBase64url, authTagBase64url] =
        parts as [string, string, string, string];
      if (version !== FORMAT_VERSION) {
        throw new SecretDecryptionError(`unsupported format version "${version}"`);
      }
      const initializationVector = Buffer.from(initializationVectorBase64url, 'base64url');
      const authTag = Buffer.from(authTagBase64url, 'base64url');
      if (
        initializationVector.length !== INITIALIZATION_VECTOR_LENGTH_BYTES ||
        authTag.length !== AUTH_TAG_LENGTH_BYTES
      ) {
        throw new SecretDecryptionError('initialization vector or auth tag has the wrong length');
      }

      // The same construct run backwards: same key, the vector read from the stored string,
      // the same authenticated "v1", and the stored tag presented for final() to verify.
      const decipher = createDecipheriv(ALGORITHM, encryptionKey, initializationVector, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      decipher.setAAD(Buffer.from(FORMAT_VERSION));
      decipher.setAuthTag(authTag);
      try {
        return Buffer.concat([
          decipher.update(Buffer.from(encryptedBase64url, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        // final() recomputes the tag; wrong key or tampered bytes and GCM releases no plaintext.
        throw new SecretDecryptionError('authentication failed');
      }
    },
  };
}
