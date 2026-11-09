import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { fakeDownloadUrlExpiresAt } from '../fakeAttachmentDownloadUrlSigner.test-helper.js';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const emailId = '00000000-0000-4000-8000-000000000001';
const otherEmailId = '00000000-0000-4000-8000-000000000002';
const pdfAttachmentId = '00000000-0000-4000-8000-00000000000a';
const logoAttachmentId = '00000000-0000-4000-8000-00000000000b';
const otherAttachmentId = '00000000-0000-4000-8000-00000000000c';

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

/** One email with a PDF and an inline logo in the session mailbox; another mailbox's email with its own file. */
function seedAttachments(testApp: TestApp, scope: { mailboxId: string; tenantId: string }): void {
  const emailFields = {
    gmailThreadId: 'thread-1',
    gmailLabel: 'inbox' as const,
    senderName: 'Ravi Kumar',
    senderEmail: 'ravi@acme.com',
    toRecipients: [],
    subject: 'Rate card',
    snippet: '',
    receivedAt: new Date('2026-11-09T12:00:00Z'),
  };
  testApp.repositories.addEmail({ ...scope, id: emailId, ...emailFields });
  testApp.repositories.addEmail({
    mailboxId: 'someone-else',
    tenantId: scope.tenantId,
    id: otherEmailId,
    ...emailFields,
  });
  const storage = {
    sha256: 'ab'.repeat(32),
    s3Key: `${scope.tenantId}/attachments/${'ab'.repeat(32)}`,
  };
  testApp.repositories.addAttachment({
    ...storage,
    id: pdfAttachmentId,
    emailId,
    tenantId: scope.tenantId,
    fileName: 'rate-card.pdf',
    contentType: 'application/pdf',
    sizeBytes: 12345,
    contentId: undefined,
    isInline: false,
  });
  testApp.repositories.addAttachment({
    ...storage,
    id: logoAttachmentId,
    emailId,
    tenantId: scope.tenantId,
    fileName: 'logo.png',
    contentType: 'image/png',
    sizeBytes: 8,
    contentId: 'logo@acme.com',
    isInline: true,
  });
  testApp.repositories.addAttachment({
    ...storage,
    id: otherAttachmentId,
    emailId: otherEmailId,
    tenantId: scope.tenantId,
    fileName: 'not-yours.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1,
    contentId: undefined,
    isInline: false,
  });
}

describe('GET /v1/mailbox/emails/:emailId/attachments', () => {
  it('lists files then inline parts, without storage details, and requires a session', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedAttachments(testApp, scope);

    const response = await request(testApp.app)
      .get(`/v1/mailbox/emails/${emailId}/attachments`)
      .set('Cookie', scope.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      emailId,
      attachments: [
        {
          id: pdfAttachmentId,
          fileName: 'rate-card.pdf',
          contentType: 'application/pdf',
          sizeBytes: 12345,
          isInline: false,
        },
        {
          id: logoAttachmentId,
          fileName: 'logo.png',
          contentType: 'image/png',
          sizeBytes: 8,
          isInline: true,
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain('s3Key');
    expect(JSON.stringify(response.body)).not.toContain('sha256');

    const anonymous = await request(testApp.app).get(`/v1/mailbox/emails/${emailId}/attachments`);
    expect(anonymous.status).toBe(401);
  });

  it("is 404 for another mailbox's email, an unknown email and a malformed id", async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedAttachments(testApp, scope);

    const other = await request(testApp.app)
      .get(`/v1/mailbox/emails/${otherEmailId}/attachments`)
      .set('Cookie', scope.cookie);
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: 'not_found' });

    const unknown = await request(testApp.app)
      .get('/v1/mailbox/emails/00000000-0000-4000-8000-0000000000ff/attachments')
      .set('Cookie', scope.cookie);
    expect(unknown.status).toBe(404);

    const malformed = await request(testApp.app)
      .get('/v1/mailbox/emails/not-a-uuid/attachments')
      .set('Cookie', scope.cookie);
    expect(malformed.status).toBe(404);
    expect(malformed.body).toEqual({ error: 'not_found' });
  });
});

describe('GET /v1/mailbox/emails/:emailId/attachments/:attachmentId/download-url', () => {
  it('returns a short-lived link for the session mailbox file, uncached', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedAttachments(testApp, scope);

    const response = await request(testApp.app)
      .get(`/v1/mailbox/emails/${emailId}/attachments/${pdfAttachmentId}/download-url`)
      .set('Cookie', scope.cookie);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      url: `https://fake-bucket.example/${scope.tenantId}/attachments/${'ab'.repeat(32)}?fileName=rate-card.pdf`,
      expiresAt: fakeDownloadUrlExpiresAt.toISOString(),
    });
  });

  it("is 404 for another mailbox's file, a file on the wrong email, an unknown id and a malformed id", async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedAttachments(testApp, scope);
    const paths = [
      `/v1/mailbox/emails/${otherEmailId}/attachments/${otherAttachmentId}/download-url`,
      `/v1/mailbox/emails/${emailId}/attachments/${otherAttachmentId}/download-url`,
      `/v1/mailbox/emails/${emailId}/attachments/00000000-0000-4000-8000-0000000000ff/download-url`,
      `/v1/mailbox/emails/${emailId}/attachments/not-a-uuid/download-url`,
    ];

    for (const path of paths) {
      const response = await request(testApp.app).get(path).set('Cookie', scope.cookie);
      expect(response.status, path).toBe(404);
      expect(response.body, path).toEqual({ error: 'not_found' });
    }
  });

  it('is 503 attachments_unavailable when the API has no bucket configured, and still requires a session', async () => {
    const testApp = createTestApp({ attachmentDownloadsEnabled: false });
    const scope = await signedInMailbox(testApp);
    seedAttachments(testApp, scope);

    const response = await request(testApp.app)
      .get(`/v1/mailbox/emails/${emailId}/attachments/${pdfAttachmentId}/download-url`)
      .set('Cookie', scope.cookie);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'attachments_unavailable' });

    const anonymous = await request(testApp.app).get(
      `/v1/mailbox/emails/${emailId}/attachments/${pdfAttachmentId}/download-url`,
    );
    expect(anonymous.status).toBe(401);
  });
});
