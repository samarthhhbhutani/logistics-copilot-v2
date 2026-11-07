import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretDecryptionError, createEncryptionUtil } from './encryptionUtil.js';

const encryptionKeyBase64 = randomBytes(32).toString('base64');
const encryptionUtil = createEncryptionUtil(encryptionKeyBase64);

describe('createEncryptionUtil()', () => {
  it('rejects a key that is not 32 bytes', () => {
    expect(() => createEncryptionUtil(randomBytes(16).toString('base64'))).toThrow(
      /32 bytes, got 16/,
    );
    expect(() => createEncryptionUtil('')).toThrow(/32 bytes, got 0/);
  });
});

describe('encryptSecret() / decryptSecret()', () => {
  it('round-trips text including unicode and the empty string', () => {
    for (const plaintext of ['1//0gabc-refresh-token', 'dépôt 🚚', '']) {
      expect(encryptionUtil.decryptSecret(encryptionUtil.encryptSecret(plaintext))).toBe(plaintext);
    }
  });

  it('produces v1 base64url output and a fresh initialization vector per call', () => {
    const first = encryptionUtil.encryptSecret('same secret');
    const second = encryptionUtil.encryptSecret('same secret');
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
  });

  it('refuses ciphertext encrypted under a different key', () => {
    const otherEncryptionUtil = createEncryptionUtil(randomBytes(32).toString('base64'));
    const ciphertext = otherEncryptionUtil.encryptSecret('secret');
    expect(() => encryptionUtil.decryptSecret(ciphertext)).toThrow(SecretDecryptionError);
    expect(() => encryptionUtil.decryptSecret(ciphertext)).toThrow(/authentication failed/);
  });

  it('refuses tampered ciphertext', () => {
    const [version, initializationVector, encrypted, authTag] = encryptionUtil
      .encryptSecret('secret')
      .split('.');
    const flippedFirstChar = encrypted!.startsWith('A') ? 'B' : 'A';
    const tampered = [
      version,
      initializationVector,
      flippedFirstChar + encrypted!.slice(1),
      authTag,
    ].join('.');
    expect(() => encryptionUtil.decryptSecret(tampered)).toThrow(SecretDecryptionError);
  });

  it('refuses malformed input with a specific reason', () => {
    expect(() => encryptionUtil.decryptSecret('not-a-ciphertext')).toThrow(/4 dot-separated parts/);
    expect(() => encryptionUtil.decryptSecret('v2.a.b.c')).toThrow(
      /unsupported format version "v2"/,
    );
    expect(() => encryptionUtil.decryptSecret('v1.short.b.c')).toThrow(/wrong length/);
  });
});
