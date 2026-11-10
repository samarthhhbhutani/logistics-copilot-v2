import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const rulesPath = '/v1/mailbox/classification-rules';

async function signedInMailbox(
  { app }: TestApp,
  email = testMailboxEmail,
): Promise<{ cookie: string; tenantId: string }> {
  const tenant = await request(app).post('/v1/tenants').send(testTenantBody);
  await request(app)
    .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
    .send({ email, password });
  const login = await request(app).post('/v1/auth/login').send({ email, password });
  const setCookie = login.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  return {
    cookie: cookies.find((cookie) => cookie.startsWith('lc_session='))!,
    tenantId: tenant.body.tenantId,
  };
}

describe('POST /v1/mailbox/classification-rules', () => {
  it('creates a rule for the session tenant, normalising the pattern, and defaults priority and enabled', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);

    const created = await request(testApp.app)
      .post(rulesPath)
      .set('Cookie', cookie)
      .send({ senderPattern: '  Ravi@ACME.com ', label: 'customer_request' });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      senderPattern: 'ravi@acme.com',
      label: 'customer_request',
      priority: 100,
      enabled: true,
    });
    expect(z.uuid().safeParse(created.body.id).success).toBe(true);
    expect(new Date(created.body.createdAt).getTime()).not.toBeNaN();
  });

  it('accepts a bare domain and rejects anything that is neither an address nor a domain', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const post = (senderPattern: string) =>
      request(testApp.app)
        .post(rulesPath)
        .set('Cookie', cookie)
        .send({ senderPattern, label: 'general' });

    expect((await post('Acme.com')).body.senderPattern).toBe('acme.com');
    for (const bad of ['', 'acme', 'ravi@acme', 'has space.com', '@acme.com', 'a@b@c.com']) {
      const response = await post(bad);
      expect(response.status, bad).toBe(400);
      expect(response.body.error, bad).toMatch(/^invalid_body: senderPattern/);
    }
  });

  it('rejects an unknown label and a non-integer priority', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);

    const badLabel = await request(testApp.app)
      .post(rulesPath)
      .set('Cookie', cookie)
      .send({ senderPattern: 'acme.com', label: 'spam' });
    const badPriority = await request(testApp.app)
      .post(rulesPath)
      .set('Cookie', cookie)
      .send({ senderPattern: 'acme.com', label: 'general', priority: 1.5 });

    expect(badLabel.status).toBe(400);
    expect(badLabel.body.error).toMatch(/^invalid_body: label/);
    expect(badPriority.status).toBe(400);
    expect(badPriority.body.error).toMatch(/^invalid_body: priority/);
  });

  it('answers 409 rule_exists for a second rule on the same pattern, whatever its case', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const post = (senderPattern: string) =>
      request(testApp.app)
        .post(rulesPath)
        .set('Cookie', cookie)
        .send({ senderPattern, label: 'general' });

    expect((await post('acme.com')).status).toBe(201);
    const duplicate = await post('ACME.com');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({ error: 'rule_exists' });
  });

  it('ignores a tenantId in the body: the rule lands in the session tenant', async () => {
    const testApp = createTestApp();
    const mine = await signedInMailbox(testApp);
    const other = await signedInMailbox(testApp, 'other@example.com');

    const created = await request(testApp.app)
      .post(rulesPath)
      .set('Cookie', mine.cookie)
      .send({ senderPattern: 'acme.com', label: 'general', tenantId: other.tenantId });
    expect(created.status).toBe(201);

    const mineListed = await request(testApp.app).get(rulesPath).set('Cookie', mine.cookie);
    const otherListed = await request(testApp.app).get(rulesPath).set('Cookie', other.cookie);
    expect(mineListed.body.rules).toHaveLength(1);
    expect(otherListed.body.rules).toEqual([]);
  });

  it('requires a session', async () => {
    const testApp = createTestApp();
    const response = await request(testApp.app)
      .post(rulesPath)
      .send({ senderPattern: 'acme.com', label: 'general' });
    expect(response.status).toBe(401);
  });
});

describe('GET /v1/mailbox/classification-rules', () => {
  it("lists only the session tenant's rules, lowest priority first", async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const other = await signedInMailbox(testApp, 'other@example.com');
    const create = (sessionCookie: string, senderPattern: string, priority: number) =>
      request(testApp.app)
        .post(rulesPath)
        .set('Cookie', sessionCookie)
        .send({ senderPattern, label: 'general', priority });

    await create(cookie, 'late.com', 200);
    await create(cookie, 'early.com', 10);
    await create(other.cookie, 'elsewhere.com', 1);

    const listed = await request(testApp.app).get(rulesPath).set('Cookie', cookie);

    expect(listed.status).toBe(200);
    expect(listed.body.rules.map((rule: { senderPattern: string }) => rule.senderPattern)).toEqual([
      'early.com',
      'late.com',
    ]);
  });

  it('requires a session', async () => {
    const testApp = createTestApp();
    expect((await request(testApp.app).get(rulesPath)).status).toBe(401);
  });
});
