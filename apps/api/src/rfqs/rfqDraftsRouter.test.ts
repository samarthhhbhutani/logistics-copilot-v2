import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { RfqMailDrafter, RfqMailDrafterOutcome, RfqMailToDraft } from '@lc/core';
import { draftRfqMailsResponseSchema } from '@lc/contract';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const customerEmailId = '00000000-0000-4000-8000-000000000001';
const draftsPath = '/v1/mailbox/rfqs/drafts';

const details = {
  originPort: 'Hazira, India',
  destinationPort: 'Jebel Ali, UAE',
  mode: 'sea_freight',
  containers: [{ type: '20ft', quantity: 2 }],
  commodity: 'Poly Aluminium Chloride (Powder)',
  incoterm: 'fob',
};

/** Writes a recognisable draft per category and records every request. */
function fakeDrafter(
  outcomeFor: (input: RfqMailToDraft) => RfqMailDrafterOutcome,
): RfqMailDrafter & { asked: RfqMailToDraft[] } {
  const asked: RfqMailToDraft[] = [];
  return {
    asked,
    async draft(input) {
      asked.push(input);
      return outcomeFor(input);
    },
  };
}

const drafted = (input: RfqMailToDraft): RfqMailDrafterOutcome => ({
  outcome: 'drafted',
  draft: {
    subject: `RFQ for ${input.category}`,
    bodyText: `Dear Team,\n${input.category} questions\nBest regards,`,
  },
  model: 'gpt-6-luna-2026-10-01',
  promptVersion: 'draft-rfq-mail-v1',
});

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

function seedCustomerMail(testApp: TestApp, scope: { mailboxId: string; tenantId: string }): void {
  testApp.repositories.addEmail({
    ...scope,
    id: customerEmailId,
    gmailThreadId: '1a1c',
    gmailLabel: 'inbox',
    senderName: 'Ravi Kumar',
    senderEmail: 'ravi@acme.com',
    toRecipients: [{ name: '', address: testMailboxEmail }],
    subject: 'RFQ: 2 x 20ft India to UAE',
    snippet: '',
    receivedAt: new Date('2026-11-10T10:00:00Z'),
    bodyText: 'Please quote 2 x 20ft Hazira to Jebel Ali, FOB.',
  });
}

/** Two carriers (one archived) and one CHA; returns their ids. */
async function seedVendors(
  testApp: TestApp,
  cookie: string,
): Promise<{ carrierId: string; archivedCarrierId: string; chaId: string }> {
  const create = async (vendorName: string, category: string) => {
    const response = await request(testApp.app)
      .post('/v1/mailbox/vendors')
      .set('Cookie', cookie)
      .send({ vendorName, category });
    return response.body.id as string;
  };
  const carrierId = await create('Sea Lines', 'carrier');
  const archivedCarrierId = await create('Old Lines', 'carrier');
  await request(testApp.app)
    .patch(`/v1/mailbox/vendors/${archivedCarrierId}`)
    .set('Cookie', cookie)
    .send({ active: false });
  const chaId = await create('Port Clearers', 'cha');
  return { carrierId, archivedCarrierId, chaId };
}

describe('POST /v1/mailbox/rfqs/drafts', () => {
  it('writes one draft per category among the chosen vendors, carrier first, from the normalised details and the source mail', async () => {
    const drafter = fakeDrafter(drafted);
    const testApp = createTestApp({ rfqMailDrafter: drafter });
    const scope = await signedInMailbox(testApp);
    seedCustomerMail(testApp, scope);
    const { carrierId, chaId } = await seedVendors(testApp, scope.cookie);

    const response = await request(testApp.app)
      .post(draftsPath)
      .set('Cookie', scope.cookie)
      .send({ sourceEmailId: customerEmailId, details, vendorIds: [chaId, carrierId] });

    expect(response.status).toBe(200);
    const body = draftRfqMailsResponseSchema.parse(response.body);
    expect(body.drafts.map((draft) => draft.category)).toEqual(['carrier', 'cha']);
    expect(body.drafts[0]).toMatchObject({
      subject: 'RFQ for carrier',
      model: 'gpt-6-luna-2026-10-01',
      promptVersion: 'draft-rfq-mail-v1',
    });
    expect(drafter.asked.map((input) => input.category)).toEqual(['carrier', 'cha']);
    expect(drafter.asked[0]!.details).toEqual({
      originPort: 'Hazira, India',
      destinationPort: 'Jebel Ali, UAE',
      senderAddress: null,
      receiverAddress: null,
      mode: 'sea_freight',
      containers: [{ type: '20ft', quantity: 2 }],
      commodity: 'Poly Aluminium Chloride (Powder)',
      grossWeightKg: null,
      volumeCbm: null,
      incoterm: 'FOB',
      readyDate: null,
      specialInstructions: null,
    });
    expect(drafter.asked[0]!.customerMail).toEqual({
      senderName: 'Ravi Kumar',
      senderEmail: 'ravi@acme.com',
      subject: 'RFQ: 2 x 20ft India to UAE',
      bodyText: 'Please quote 2 x 20ft Hazira to Jebel Ali, FOB.',
    });
  });

  it('makes one call when every chosen vendor shares a category', async () => {
    const drafter = fakeDrafter(drafted);
    const testApp = createTestApp({ rfqMailDrafter: drafter });
    const scope = await signedInMailbox(testApp);
    seedCustomerMail(testApp, scope);
    const { carrierId } = await seedVendors(testApp, scope.cookie);

    const response = await request(testApp.app)
      .post(draftsPath)
      .set('Cookie', scope.cookie)
      .send({ sourceEmailId: customerEmailId, details, vendorIds: [carrierId] });

    expect(response.status).toBe(200);
    expect(response.body.drafts).toHaveLength(1);
    expect(drafter.asked).toHaveLength(1);
  });

  it('is 404 vendor_not_found for an archived or unknown vendor and 404 email_not_found for an unknown mail, without drafting', async () => {
    const drafter = fakeDrafter(drafted);
    const testApp = createTestApp({ rfqMailDrafter: drafter });
    const scope = await signedInMailbox(testApp);
    seedCustomerMail(testApp, scope);
    const { carrierId, archivedCarrierId } = await seedVendors(testApp, scope.cookie);

    for (const vendorIds of [
      [carrierId, archivedCarrierId],
      ['00000000-0000-4000-8000-0000000000ff'],
    ]) {
      const response = await request(testApp.app)
        .post(draftsPath)
        .set('Cookie', scope.cookie)
        .send({ sourceEmailId: customerEmailId, details, vendorIds });
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('vendor_not_found');
    }
    const unknownMail = await request(testApp.app)
      .post(draftsPath)
      .set('Cookie', scope.cookie)
      .send({
        sourceEmailId: '00000000-0000-4000-8000-0000000000ee',
        details,
        vendorIds: [carrierId],
      });
    expect(unknownMail.status).toBe(404);
    expect(unknownMail.body.error).toBe('email_not_found');
    expect(drafter.asked).toEqual([]);
  });

  it('is 400 for a body without ports, without vendors, or with a repeated vendor', async () => {
    const testApp = createTestApp({ rfqMailDrafter: fakeDrafter(drafted) });
    const scope = await signedInMailbox(testApp);
    seedCustomerMail(testApp, scope);
    const { carrierId } = await seedVendors(testApp, scope.cookie);

    for (const body of [
      { sourceEmailId: customerEmailId, details: { originPort: 'Hazira' }, vendorIds: [carrierId] },
      { sourceEmailId: customerEmailId, details, vendorIds: [] },
      { sourceEmailId: customerEmailId, details, vendorIds: [carrierId, carrierId] },
    ]) {
      const response = await request(testApp.app)
        .post(draftsPath)
        .set('Cookie', scope.cookie)
        .send(body);
      expect(response.status).toBe(400);
    }
  });

  it('is 503 drafts_unavailable without a drafter, 503 when any category call must be retried, 422 when one failed', async () => {
    const cases: [RfqMailDrafter | undefined, number, string][] = [
      [undefined, 503, 'drafts_unavailable'],
      [
        fakeDrafter((input) =>
          input.category === 'cha' ? { outcome: 'retry', detail: '429' } : drafted(input),
        ),
        503,
        'drafts_unavailable',
      ],
      [
        fakeDrafter((input) =>
          input.category === 'cha' ? { outcome: 'failed', detail: 'refusal' } : drafted(input),
        ),
        422,
        'drafts_failed',
      ],
    ];
    for (const [rfqMailDrafter, status, error] of cases) {
      const testApp = createTestApp({ rfqMailDrafter });
      const scope = await signedInMailbox(testApp);
      seedCustomerMail(testApp, scope);
      const { carrierId, chaId } = await seedVendors(testApp, scope.cookie);

      const response = await request(testApp.app)
        .post(draftsPath)
        .set('Cookie', scope.cookie)
        .send({ sourceEmailId: customerEmailId, details, vendorIds: [carrierId, chaId] });

      expect(response.status).toBe(status);
      expect(response.body.error).toBe(error);
    }
  });

  it('needs a session', async () => {
    const testApp = createTestApp();
    const response = await request(testApp.app).post(draftsPath).send({});
    expect(response.status).toBe(401);
  });
});
