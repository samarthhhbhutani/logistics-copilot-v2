import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const inboxEmailId = '00000000-0000-4000-8000-000000000001';
const sentEmailId = '00000000-0000-4000-8000-000000000002';
const otherTenantEmailId = '00000000-0000-4000-8000-000000000003';
const otherMailboxEmailId = '00000000-0000-4000-8000-000000000004';
const classificationsPath = (emailId: string) => `/v1/mailbox/emails/${emailId}/classifications`;

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

/** One inbox mail labelled by the model, one sent mail, and inbox mails of another tenant (same mailbox id) and another mailbox (same tenant). */
function seedMails(testApp: TestApp, scope: { mailboxId: string; tenantId: string }): void {
  const base = {
    senderName: 'Ravi Kumar',
    senderEmail: 'ravi@acme.com',
    toRecipients: [{ name: '', address: testMailboxEmail }],
    subject: 'RFQ',
    snippet: '',
    receivedAt: new Date('2026-11-10T10:00:00Z'),
  };
  testApp.repositories.addEmail({
    ...scope,
    ...base,
    id: inboxEmailId,
    gmailThreadId: '1a1c',
    gmailLabel: 'inbox',
  });
  testApp.repositories.setClassification(inboxEmailId, {
    label: 'general',
    source: 'llm',
    confidence: 0.6,
    classifiedAt: new Date('2026-11-10T10:00:05Z'),
  });
  testApp.repositories.addEmail({
    ...scope,
    ...base,
    id: sentEmailId,
    gmailThreadId: '1a1c',
    gmailLabel: 'sent',
  });
  testApp.repositories.addEmail({
    ...scope,
    ...base,
    tenantId: '22222222-2222-4222-8222-222222222222',
    id: otherTenantEmailId,
    gmailThreadId: '2b2d',
    gmailLabel: 'inbox',
  });
  testApp.repositories.addEmail({
    ...scope,
    ...base,
    mailboxId: '11111111-1111-4111-8111-111111111111',
    id: otherMailboxEmailId,
    gmailThreadId: '3c3e',
    gmailLabel: 'inbox',
  });
}

describe('POST /v1/mailbox/emails/:emailId/classifications', () => {
  it('appends a user row and the mail reports it as current, customer_reply included', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedMails(testApp, scope);

    const corrected = await request(testApp.app)
      .post(classificationsPath(inboxEmailId))
      .set('Cookie', scope.cookie)
      .send({ label: 'customer_reply' });

    expect(corrected.status).toBe(201);
    expect(corrected.body).toMatchObject({
      label: 'customer_reply',
      source: 'user',
      confidence: null,
    });
    expect(typeof corrected.body.classifiedAt).toBe('string');

    const detail = await request(testApp.app)
      .get(`/v1/mailbox/emails/${inboxEmailId}`)
      .set('Cookie', scope.cookie);
    expect(detail.body.classification).toEqual(corrected.body);
  });

  it('answers 409 not_inbound for a sent mail', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedMails(testApp, scope);

    const response = await request(testApp.app)
      .post(classificationsPath(sentEmailId))
      .set('Cookie', scope.cookie)
      .send({ label: 'general' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'not_inbound' });
  });

  it('answers 404 for an unknown id, a malformed id, another tenant and another mailbox, and 401 without a session', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedMails(testApp, scope);

    for (const emailId of [
      '00000000-0000-4000-8000-000000000099',
      'not-a-uuid',
      otherTenantEmailId,
      otherMailboxEmailId,
    ]) {
      const response = await request(testApp.app)
        .post(classificationsPath(emailId))
        .set('Cookie', scope.cookie)
        .send({ label: 'general' });
      expect(response.status, emailId).toBe(404);
      expect(response.body).toEqual({ error: 'not_found' });
    }
    expect(
      (
        await request(testApp.app)
          .post(classificationsPath(inboxEmailId))
          .send({ label: 'general' })
      ).status,
    ).toBe(401);
  });

  it('rejects an unknown label and a missing body', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedMails(testApp, scope);

    const badLabel = await request(testApp.app)
      .post(classificationsPath(inboxEmailId))
      .set('Cookie', scope.cookie)
      .send({ label: 'spam' });
    const noBody = await request(testApp.app)
      .post(classificationsPath(inboxEmailId))
      .set('Cookie', scope.cookie)
      .send({});

    expect(badLabel.status).toBe(400);
    expect(badLabel.body.error).toMatch(/^invalid_body: label/);
    expect(noBody.status).toBe(400);
    expect(noBody.body.error).toMatch(/^invalid_body: label/);
  });
});
