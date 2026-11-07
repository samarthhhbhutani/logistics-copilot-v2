import request from 'supertest';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestAppInstance } from '../testAppInstance.test-helper.js';

const mailboxBody = { email: 'Ops@Bhatia.example', password: 'a-long-enough-password' };

async function createMailbox(app: Express): Promise<{ mailboxId: string; tenantId: string }> {
  const tenant = await request(app).post('/v1/tenants').send(testTenantBody);
  const mailbox = await request(app)
    .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
    .send(mailboxBody);
  return mailbox.body;
}

function sessionCookieFrom(response: request.Response): string {
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const sessionCookie = cookies.find((cookie) => cookie.startsWith('lc_session='));
  expect(sessionCookie).toBeDefined();
  return sessionCookie as string;
}

describe('auth', () => {
  it('login sets an httpOnly session cookie and /me reads the claims back; email is case-insensitive', async () => {
    const app = createTestAppInstance();
    const created = await createMailbox(app);
    const login = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'ops@bhatia.example', password: mailboxBody.password });
    expect(login.status).toBe(200);
    expect(login.body).toEqual(created);
    const cookie = sessionCookieFrom(login);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/); // dev stage: http://localhost

    const me = await request(app).get('/v1/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toEqual(created);
  });

  it('cookie is Secure outside dev', async () => {
    const app = createTestAppInstance('staging');
    await createMailbox(app);
    const login = await request(app).post('/v1/auth/login').send(mailboxBody);
    expect(sessionCookieFrom(login)).toMatch(/Secure/);
  });

  it('wrong password and unknown email both give the same 401', async () => {
    const app = createTestAppInstance();
    await createMailbox(app);
    const wrongPassword = await request(app)
      .post('/v1/auth/login')
      .send({ email: mailboxBody.email, password: 'definitely-not-the-password' });
    const unknownEmail = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'nobody@bhatia.example', password: mailboxBody.password });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('/me without a cookie, with a tampered cookie, and after logout is 401', async () => {
    const app = createTestAppInstance();
    expect((await request(app).get('/v1/me')).status).toBe(401);
    expect((await request(app).get('/v1/me').set('Cookie', 'lc_session=garbage')).status).toBe(401);

    const logout = await request(app).post('/v1/auth/logout');
    expect(logout.status).toBe(204);
    expect(sessionCookieFrom(logout)).toMatch(/lc_session=;/);
  });
});
