import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';

/** Operator creates tenant + mailbox, the owner logs in; returns the session cookie. */
async function signedInMailbox({
  app,
}: TestApp): Promise<{ cookie: string; mailboxId: string; tenantId: string }> {
  const tenant = await request(app).post('/v1/tenants').send(testTenantBody);
  const mailbox = await request(app)
    .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
    .send({ email: testMailboxEmail, password });
  const login = await request(app)
    .post('/v1/auth/login')
    .send({ email: testMailboxEmail, password });
  const setCookie = login.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  return {
    cookie: cookies.find((cookie) => cookie.startsWith('lc_session='))!,
    mailboxId: mailbox.body.mailboxId,
    tenantId: tenant.body.tenantId,
  };
}

/** Pretends to be the browser coming back from Google with the state from the consent URL. */
function stateFromConsentUrl(url: string): string {
  return new URL(url).searchParams.get('state')!;
}

describe('GET /v1/mailbox', () => {
  it('shows the own mailbox as not connected; requires a session', async () => {
    const testApp = createTestApp();
    const { cookie, mailboxId, tenantId } = await signedInMailbox(testApp);
    const response = await request(testApp.app).get('/v1/mailbox').set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      mailboxId,
      tenantId,
      emailAddress: testMailboxEmail,
      gmailConnectionStatus: 'not_connected',
      gmailConnectedAt: null,
    });
    expect((await request(testApp.app).get('/v1/mailbox')).status).toBe(401);
  });
});

describe('Gmail connect flow', () => {
  it('connect returns a consent URL built from the tenant client, then the callback stores an encrypted token', async () => {
    const testApp = createTestApp();
    const { cookie, mailboxId, tenantId } = await signedInMailbox(testApp);

    const connect = await request(testApp.app)
      .post('/v1/mailbox/gmail/connect')
      .set('Cookie', cookie);
    expect(connect.status).toBe(200);
    const consentUrl = new URL(connect.body.url);
    expect(consentUrl.searchParams.get('client_id')).toBe(testTenantBody.googleClientId);
    expect(consentUrl.searchParams.get('login_hint')).toBe(testMailboxEmail);
    // The tenant's secret was decrypted for Google, not handed over encrypted.
    expect(testApp.gmailOAuth.credentialsSeen[0]?.clientSecret).toBe(
      testTenantBody.googleClientSecret,
    );

    // The callback is a top-level navigation from Google: no cookie.
    const callback = await request(testApp.app)
      .get('/v1/mailbox/gmail/callback')
      .query({ code: 'code-123', state: stateFromConsentUrl(connect.body.url) });
    expect(callback.status).toBe(200);
    expect(callback.body).toEqual({ connected: true });
    expect(testApp.gmailOAuth.exchangedCodes).toEqual(['code-123']);

    const stored = await testApp.repositories.mailboxConnectionRepository.findMailboxConnection({
      mailboxId,
      tenantId,
    });
    expect(stored?.gmailConnectionStatus).toBe('connected');
    expect(stored?.encryptedRefreshToken).toMatch(/^v1\./);
    expect(testApp.encryptionUtil.decryptSecret(stored!.encryptedRefreshToken!)).toBe(
      'refresh-token-for:code-123',
    );

    const view = await request(testApp.app).get('/v1/mailbox').set('Cookie', cookie);
    expect(view.body.gmailConnectionStatus).toBe('connected');
    expect(view.body.gmailConnectedAt).toEqual(expect.any(String));
  });

  it('redirects to the portal with the outcome when PORTAL_URL is set', async () => {
    const testApp = createTestApp({ portalUrl: 'https://portal.example' });
    const { cookie } = await signedInMailbox(testApp);
    const connect = await request(testApp.app)
      .post('/v1/mailbox/gmail/connect')
      .set('Cookie', cookie);
    const state = stateFromConsentUrl(connect.body.url);

    const success = await request(testApp.app)
      .get('/v1/mailbox/gmail/callback')
      .query({ code: 'code-1', state });
    expect(success.status).toBe(302);
    expect(success.headers.location).toBe('https://portal.example/mailbox?connected=1');

    const denied = await request(testApp.app)
      .get('/v1/mailbox/gmail/callback')
      .query({ error: 'access_denied', state });
    expect(denied.status).toBe(302);
    expect(denied.headers.location).toBe('https://portal.example/mailbox?error=denied');
  });

  it('rejects a wrong Google account: token revoked, nothing stored, expected address reported', async () => {
    const testApp = createTestApp({ consentingAccountEmail: 'someone.else@gmail.com' });
    const { cookie } = await signedInMailbox(testApp);
    const connect = await request(testApp.app)
      .post('/v1/mailbox/gmail/connect')
      .set('Cookie', cookie);

    const callback = await request(testApp.app)
      .get('/v1/mailbox/gmail/callback')
      .query({ code: 'code-9', state: stateFromConsentUrl(connect.body.url) });
    expect(callback.status).toBe(400);
    expect(callback.body).toEqual({
      connected: false,
      error: 'email_mismatch',
      expectedEmail: testMailboxEmail,
    });
    expect(testApp.gmailOAuth.revokedRefreshTokens).toEqual(['refresh-token-for:code-9']);

    const view = await request(testApp.app).get('/v1/mailbox').set('Cookie', cookie);
    expect(view.body.gmailConnectionStatus).toBe('not_connected');
  });

  it('revokes and reports scope_not_granted when the Gmail checkbox was left unticked', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    // Google still returns a token when only openid + email were granted; it just cannot read mail.
    testApp.gmailOAuth.grantedScopes = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];
    const connect = await request(testApp.app)
      .post('/v1/mailbox/gmail/connect')
      .set('Cookie', cookie);

    const callback = await request(testApp.app)
      .get('/v1/mailbox/gmail/callback')
      .query({ code: 'code-5', state: stateFromConsentUrl(connect.body.url) });
    expect(callback.status).toBe(400);
    expect(callback.body).toEqual({ connected: false, error: 'scope_not_granted' });
    expect(testApp.gmailOAuth.revokedRefreshTokens).toEqual(['refresh-token-for:code-5']);

    const view = await request(testApp.app).get('/v1/mailbox').set('Cookie', cookie);
    expect(view.body.gmailConnectionStatus).toBe('not_connected');
  });

  it('rejects a missing, forged or session-cookie state and a failed code exchange', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);

    const noState = await request(testApp.app)
      .get('/v1/mailbox/gmail/callback')
      .query({ code: 'x' });
    expect(noState.body).toEqual({ connected: false, error: 'invalid_state' });

    const sessionAsState = await request(testApp.app)
      .get('/v1/mailbox/gmail/callback')
      .query({ code: 'x', state: cookie.split(';')[0]!.replace('lc_session=', '') });
    expect(sessionAsState.body).toEqual({ connected: false, error: 'invalid_state' });

    const connect = await request(testApp.app)
      .post('/v1/mailbox/gmail/connect')
      .set('Cookie', cookie);
    testApp.gmailOAuth.failNextExchange = true;
    const failed = await request(testApp.app)
      .get('/v1/mailbox/gmail/callback')
      .query({ code: 'reused', state: stateFromConsentUrl(connect.body.url) });
    expect(failed.status).toBe(400);
    expect(failed.body).toEqual({ connected: false, error: 'exchange_failed' });
  });

  it('DELETE /gmail revokes at Google and resets the mailbox to not connected', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const connect = await request(testApp.app)
      .post('/v1/mailbox/gmail/connect')
      .set('Cookie', cookie);
    await request(testApp.app)
      .get('/v1/mailbox/gmail/callback')
      .query({ code: 'code-5', state: stateFromConsentUrl(connect.body.url) });

    const disconnect = await request(testApp.app).delete('/v1/mailbox/gmail').set('Cookie', cookie);
    expect(disconnect.status).toBe(204);
    expect(testApp.gmailOAuth.revokedRefreshTokens).toEqual(['refresh-token-for:code-5']);
    const view = await request(testApp.app).get('/v1/mailbox').set('Cookie', cookie);
    expect(view.body).toMatchObject({
      gmailConnectionStatus: 'not_connected',
      gmailConnectedAt: null,
    });
  });
});
