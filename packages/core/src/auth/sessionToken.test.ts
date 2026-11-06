import { describe, expect, it } from 'vitest';
import { createSessionToken, verifySessionToken } from './sessionToken.js';

const sessionSecret = 'test-session-secret-that-is-at-least-32-chars';
const claims = {
  mailboxId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
};

describe('sessionToken', () => {
  it('round-trips the claims', async () => {
    const token = await createSessionToken(claims, sessionSecret);
    await expect(verifySessionToken(token, sessionSecret)).resolves.toEqual(claims);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await createSessionToken(claims, 'another-secret-that-is-also-32-chars-long');
    await expect(verifySessionToken(token, sessionSecret)).resolves.toBeUndefined();
  });

  it('rejects garbage', async () => {
    await expect(verifySessionToken('not.a.jwt', sessionSecret)).resolves.toBeUndefined();
  });
});
