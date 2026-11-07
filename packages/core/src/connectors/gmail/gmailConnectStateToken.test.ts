import { describe, expect, it } from 'vitest';
import { createSessionToken } from '../../auth/sessionToken.js';
import {
  createGmailConnectStateToken,
  verifyGmailConnectStateToken,
} from './gmailConnectStateToken.js';

const secret = 'test-secret-that-is-at-least-32-characters-long';
const claims = { mailboxId: 'mailbox-1', tenantId: 'tenant-1' };

describe('gmailConnectStateToken', () => {
  it('round-trips the mailbox and tenant', async () => {
    const stateToken = await createGmailConnectStateToken(claims, secret);
    await expect(verifyGmailConnectStateToken(stateToken, secret)).resolves.toEqual(claims);
  });

  it('rejects a tampered token, a different secret and garbage', async () => {
    const stateToken = await createGmailConnectStateToken(claims, secret);
    await expect(
      verifyGmailConnectStateToken(stateToken.slice(0, -2) + 'xx', secret),
    ).resolves.toBeUndefined();
    await expect(
      verifyGmailConnectStateToken(stateToken, 'another-secret-that-is-also-32-characters'),
    ).resolves.toBeUndefined();
    await expect(verifyGmailConnectStateToken('not.a.jwt', secret)).resolves.toBeUndefined();
  });

  it('refuses a session token used as state: same secret, different audience', async () => {
    const sessionToken = await createSessionToken(claims, secret);
    await expect(verifyGmailConnectStateToken(sessionToken, secret)).resolves.toBeUndefined();
  });
});
