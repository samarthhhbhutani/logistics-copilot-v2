import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '@lc/core';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const operatorEmail = 'operator@logistics-copilot.example';
const operatorPassword = 'a-long-operator-password';

async function appWithOperator(): Promise<TestApp> {
  const testApp = createTestApp();
  await testApp.repositories.operatorRepository.upsertOperator({
    email: operatorEmail,
    passwordHash: await hashPassword(operatorPassword),
  });
  return testApp;
}

function cookieHeaderFrom(response: request.Response): { cookie: string } {
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const operatorCookie = cookies.find((cookie) => cookie.startsWith('lc_operator='));
  if (!operatorCookie) throw new Error('no lc_operator cookie set');
  return { cookie: operatorCookie.split(';')[0] };
}

describe('operator session', () => {
  it('login sets an httpOnly lc_operator cookie that opens /operator/me and the tenant routes', async () => {
    const { app } = await appWithOperator();
    const login = await request(app)
      .post('/v1/operator/login')
      .send({ email: 'Operator@Logistics-Copilot.example', password: operatorPassword });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ operatorId: expect.any(String), email: operatorEmail });
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toContain('lc_operator=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('lc_session=');

    const me = await request(app).get('/v1/operator/me').set(cookieHeaderFrom(login));
    expect(me.status).toBe(200);
    expect(me.body).toEqual(login.body);

    const tenant = await request(app)
      .post('/v1/tenants')
      .set(cookieHeaderFrom(login))
      .send(testTenantBody);
    expect(tenant.status).toBe(201);
  });

  it('wrong password and unknown email get the same 401 and no cookie', async () => {
    const { app } = await appWithOperator();
    const wrongPassword = await request(app)
      .post('/v1/operator/login')
      .send({ email: operatorEmail, password: 'not-the-password' });
    const unknownEmail = await request(app)
      .post('/v1/operator/login')
      .send({ email: 'nobody@example.com', password: operatorPassword });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    expect(unknownEmail.headers['set-cookie']).toBeUndefined();
  });

  it('a mailbox login never opens operator routes, and /operator/me without a cookie is 401', async () => {
    const { app } = await appWithOperator();
    expect((await request(app).get('/v1/operator/me')).status).toBe(401);
    const mailboxLogin = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'nobody@bhatia.example', password: operatorPassword });
    expect(mailboxLogin.status).toBe(401);
  });

  it('logout clears the cookie and marks it Secure outside dev', async () => {
    const { app } = await appWithOperator();
    const login = await request(app)
      .post('/v1/operator/login')
      .send({ email: operatorEmail, password: operatorPassword });
    const logout = await request(app).post('/v1/operator/logout').set(cookieHeaderFrom(login));
    expect(logout.status).toBe(204);
    expect(String(logout.headers['set-cookie'])).toMatch(/lc_operator=;/);

    const staging = createTestApp({ stage: 'staging' });
    await staging.repositories.operatorRepository.upsertOperator({
      email: operatorEmail,
      passwordHash: await hashPassword(operatorPassword),
    });
    const secureLogin = await request(staging.app)
      .post('/v1/operator/login')
      .send({ email: operatorEmail, password: operatorPassword });
    expect(String(secureLogin.headers['set-cookie'])).toContain('Secure');
  });
});
