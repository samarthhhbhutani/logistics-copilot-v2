import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type {
  EmailToSuggestFrom,
  RfqSuggester,
  RfqSuggesterOutcome,
  RfqSuggestion,
} from '@lc/core';
import { rfqSuggestionResponseSchema } from '@lc/contract';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createFakeAttachmentContentReader } from '../fakeAttachmentContentReader.test-helper.js';
import {
  createTestApp,
  operatorAuthorizationHeader,
  testMailboxEmail,
} from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const customerEmailId = '00000000-0000-4000-8000-000000000001';
const otherTenantEmailId = '00000000-0000-4000-8000-000000000003';
const suggestionPath = (emailId: string) => `/v1/mailbox/emails/${emailId}/rfq-suggestion`;

const emptySuggestion: RfqSuggestion = {
  originPort: null,
  destinationPort: null,
  senderAddress: null,
  receiverAddress: null,
  mode: null,
  containers: [],
  commodity: null,
  grossWeightKg: null,
  volumeCbm: null,
  incoterm: null,
  readyDate: null,
  specialInstructions: null,
};

/** Answers every call with the given outcome and records what it was asked to read. */
function fakeSuggester(
  outcome: RfqSuggesterOutcome,
): RfqSuggester & { asked: EmailToSuggestFrom[] } {
  const asked: EmailToSuggestFrom[] = [];
  return {
    asked,
    async suggest(email) {
      asked.push(email);
      return outcome;
    },
  };
}

async function signedInMailbox({
  app,
}: TestApp): Promise<{ cookie: string; mailboxId: string; tenantId: string }> {
  const tenant = await request(app)
    .post('/v1/tenants')
    .set(operatorAuthorizationHeader)
    .send(testTenantBody);
  const mailbox = await request(app)
    .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
    .set(operatorAuthorizationHeader)
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

function seedMails(testApp: TestApp, scope: { mailboxId: string; tenantId: string }): void {
  const base = {
    senderName: 'Ravi Kumar',
    senderEmail: 'ravi@acme.com',
    toRecipients: [{ name: '', address: testMailboxEmail }],
    subject: 'Rates Mundra to Tema',
    snippet: '',
    receivedAt: new Date('2026-11-10T10:00:00Z'),
    gmailThreadId: '1a1c',
    gmailLabel: 'inbox' as const,
  };
  testApp.repositories.addEmail({
    ...scope,
    ...base,
    id: customerEmailId,
    bodyText: 'Please quote 2 x 40ft HC, granite slabs, 52 tons, FOB Mundra to Tema.',
  });
  testApp.repositories.addEmail({
    ...scope,
    ...base,
    id: otherTenantEmailId,
    tenantId: '22222222-2222-4222-8222-222222222222',
  });
}

describe('POST /v1/mailbox/emails/:emailId/rfq-suggestion', () => {
  it('hands the mail to the suggester and returns its reading with model and prompt version', async () => {
    const suggester = fakeSuggester({
      outcome: 'suggested',
      suggestion: {
        ...emptySuggestion,
        originPort: 'Mundra',
        destinationPort: 'Tema',
        containers: [{ type: '40ft HC', quantity: 2 }],
        commodity: 'granite slabs',
        grossWeightKg: 52000,
        incoterm: 'FOB',
      },
      model: 'gpt-6-luna-2026-10-01',
      promptVersion: 'suggest-rfq-v1',
    });
    const testApp = createTestApp({ rfqSuggester: suggester });
    const scope = await signedInMailbox(testApp);
    seedMails(testApp, scope);

    const response = await request(testApp.app)
      .post(suggestionPath(customerEmailId))
      .set('Cookie', scope.cookie);

    expect(response.status).toBe(200);
    const body = rfqSuggestionResponseSchema.parse(response.body);
    expect(body).toMatchObject({
      originPort: 'Mundra',
      destinationPort: 'Tema',
      containers: [{ type: '40ft HC', quantity: 2 }],
      grossWeightKg: 52000,
      incoterm: 'FOB',
      mode: null,
      model: 'gpt-6-luna-2026-10-01',
      promptVersion: 'suggest-rfq-v1',
    });
    expect(suggester.asked).toEqual([
      {
        senderName: 'Ravi Kumar',
        senderEmail: 'ravi@acme.com',
        subject: 'Rates Mundra to Tema',
        bodyText: 'Please quote 2 x 40ft HC, granite slabs, 52 tons, FOB Mundra to Tema.',
        attachments: [],
      },
    ]);
  });

  it('fetches the readable attachments when a content reader is configured: real PDFs and images only, a failed fetch skipped', async () => {
    const suggester = fakeSuggester({
      outcome: 'suggested',
      suggestion: emptySuggestion,
      model: 'm',
      promptVersion: 'suggest-rfq-v1',
    });
    const pdfBytes = new Uint8Array(Buffer.from('%PDF-1.4'));
    const reader = createFakeAttachmentContentReader({ 'tenant/sha-pdf': pdfBytes });
    const testApp = createTestApp({ rfqSuggester: suggester, attachmentContentReader: reader });
    const scope = await signedInMailbox(testApp);
    seedMails(testApp, scope);
    const stored = { emailId: customerEmailId, tenantId: scope.tenantId, contentId: undefined };
    testApp.repositories.addAttachment({
      ...stored,
      id: '00000000-0000-4000-8000-00000000000a',
      fileName: 'packing-list.pdf',
      contentType: 'application/pdf',
      sizeBytes: 8,
      sha256: 'sha-pdf',
      s3Key: 'tenant/sha-pdf',
      isInline: false,
    });
    testApp.repositories.addAttachment({
      ...stored,
      id: '00000000-0000-4000-8000-00000000000b',
      fileName: 'rates.xlsx',
      contentType: 'application/vnd.ms-excel',
      sizeBytes: 3,
      sha256: 'sha-xlsx',
      s3Key: 'tenant/sha-xlsx',
      isInline: false,
    });
    testApp.repositories.addAttachment({
      ...stored,
      id: '00000000-0000-4000-8000-00000000000c',
      fileName: 'logo.png',
      contentType: 'image/png',
      sizeBytes: 3,
      sha256: 'sha-logo',
      s3Key: 'tenant/sha-logo',
      contentId: 'logo@acme.com',
      isInline: true,
    });
    testApp.repositories.addAttachment({
      ...stored,
      id: '00000000-0000-4000-8000-00000000000d',
      fileName: 'site-photo.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 3,
      sha256: 'sha-missing',
      s3Key: 'tenant/sha-missing',
      isInline: false,
    });

    const response = await request(testApp.app)
      .post(suggestionPath(customerEmailId))
      .set('Cookie', scope.cookie);

    expect(response.status).toBe(200);
    expect(reader.read.sort()).toEqual(['tenant/sha-missing', 'tenant/sha-pdf']);
    expect(suggester.asked[0]!.attachments).toEqual([
      {
        fileName: 'packing-list.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8,
        content: pdfBytes,
        contentId: undefined,
        isInline: false,
      },
    ]);
  });

  it('is 404 email_not_found for a mail of another tenant, an unknown id and a malformed id, without calling the model', async () => {
    const suggester = fakeSuggester({ outcome: 'failed', detail: 'must not be called' });
    const testApp = createTestApp({ rfqSuggester: suggester });
    const scope = await signedInMailbox(testApp);
    seedMails(testApp, scope);

    for (const emailId of [otherTenantEmailId, '00000000-0000-4000-8000-0000000000ff']) {
      const response = await request(testApp.app)
        .post(suggestionPath(emailId))
        .set('Cookie', scope.cookie);
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('email_not_found');
    }
    const malformed = await request(testApp.app)
      .post(suggestionPath('not-a-uuid'))
      .set('Cookie', scope.cookie);
    expect(malformed.status).toBe(404);
    expect(suggester.asked).toEqual([]);
  });

  it('is 503 suggestion_unavailable when no suggester is configured', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedMails(testApp, scope);

    const response = await request(testApp.app)
      .post(suggestionPath(customerEmailId))
      .set('Cookie', scope.cookie);

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('suggestion_unavailable');
  });

  it('is 503 suggestion_unavailable on a retryable provider failure and 422 suggestion_failed on a bad reading', async () => {
    for (const [outcome, status, error] of [
      ['retry', 503, 'suggestion_unavailable'],
      ['failed', 422, 'suggestion_failed'],
    ] as const) {
      const testApp = createTestApp({ rfqSuggester: fakeSuggester({ outcome, detail: 'boom' }) });
      const scope = await signedInMailbox(testApp);
      seedMails(testApp, scope);

      const response = await request(testApp.app)
        .post(suggestionPath(customerEmailId))
        .set('Cookie', scope.cookie);

      expect(response.status).toBe(status);
      expect(response.body.error).toBe(error);
    }
  });

  it('needs a session', async () => {
    const testApp = createTestApp();
    const response = await request(testApp.app).post(suggestionPath(customerEmailId));
    expect(response.status).toBe(401);
  });
});
