import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  getRfqBySourceEmailResponseSchema,
  getRfqResponseSchema,
  sendRfqResponseSchema,
} from '@lc/contract';
import type { SendRfqResponse } from '@lc/contract';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const customerEmailId = '00000000-0000-4000-8000-000000000001';
const rfqId = '22222222-2222-4222-8222-222222222222';
const unknownId = '00000000-0000-4000-8000-0000000000ff';
const sendPath = (id: string) => `/v1/mailbox/rfqs/${id}/send`;
const rfqPath = (id: string) => `/v1/mailbox/rfqs/${id}`;
const rfqBySourceEmailPath = (emailId: string) => `/v1/mailbox/rfqs/bySourceEmail/${emailId}`;

const details = {
  originPort: 'Hazira, India',
  destinationPort: 'Jebel Ali, UAE',
  containers: [{ type: '20ft', quantity: 2 }],
  incoterm: 'fob',
};
const mails = [
  {
    category: 'carrier',
    subject: 'RFQ: carrier rates',
    bodyText: 'Dear Team,\ncarrier\nBest regards,',
  },
  { category: 'cha', subject: 'RFQ: clearance', bodyText: 'Dear Team,\ncha\nBest regards,' },
];

interface Scope {
  cookie: string;
  mailboxId: string;
  tenantId: string;
}

async function signedInMailbox({ app }: TestApp): Promise<Scope> {
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

async function connectedMailbox(testApp: TestApp, signature?: string): Promise<Scope> {
  const scope = await signedInMailbox(testApp);
  await testApp.repositories.mailboxConnectionRepository.saveGmailConnection(scope, {
    encryptedRefreshToken: testApp.encryptionUtil.encryptSecret('refresh-token-1'),
    lastHistoryId: 1n,
    watchExpiresAt: new Date('2026-11-20T00:00:00Z'),
  });
  if (signature) {
    await testApp.repositories.mailboxConnectionRepository.updateSignature(scope, signature);
  }
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
  return scope;
}

interface SeededVendors {
  carrierId: string;
  carrierContactIds: [string, string];
  archivedCarrierContactId: string;
  chaId: string;
  chaContactId: string;
  archivedVendorId: string;
}

/** A carrier with two active contacts and one archived, a CHA with one contact, and an archived vendor. */
async function seedVendors(testApp: TestApp, cookie: string): Promise<SeededVendors> {
  const createVendor = async (vendorName: string, category: string, contactNames: string[]) => {
    const response = await request(testApp.app)
      .post('/v1/mailbox/vendors')
      .set('Cookie', cookie)
      .send({
        vendorName,
        category,
        contacts: contactNames.map((contactName) => ({
          contactName,
          emailAddress: `${contactName.toLowerCase().replace(/ /g, '.')}@${vendorName.toLowerCase().replace(/ /g, '')}.example`,
        })),
      });
    return response.body as { id: string; contacts: { id: string; contactName: string }[] };
  };
  const carrier = await createVendor('Sea Lines', 'carrier', ['Asha Rao', 'Ben Lee', 'Old Hand']);
  const archivedCarrierContactId = carrier.contacts[2]!.id;
  await request(testApp.app)
    .patch(`/v1/mailbox/vendors/${carrier.id}/contacts/${archivedCarrierContactId}`)
    .set('Cookie', cookie)
    .send({ active: false });
  const cha = await createVendor('Port Clearers', 'cha', ['Chitra Nair']);
  const archived = await createVendor('Gone Lines', 'carrier', ['Nobody Here']);
  await request(testApp.app)
    .patch(`/v1/mailbox/vendors/${archived.id}`)
    .set('Cookie', cookie)
    .send({ active: false });
  return {
    carrierId: carrier.id,
    carrierContactIds: [carrier.contacts[0]!.id, carrier.contacts[1]!.id],
    archivedCarrierContactId,
    chaId: cha.id,
    chaContactId: cha.contacts[0]!.id,
    archivedVendorId: archived.id,
  };
}

function everyoneBody(vendors: SeededVendors) {
  return {
    sourceEmailId: customerEmailId,
    details,
    recipients: [
      { vendorId: vendors.carrierId, contactIds: vendors.carrierContactIds },
      { vendorId: vendors.chaId, contactIds: [vendors.chaContactId] },
    ],
    mails,
  };
}

function send(testApp: TestApp, cookie: string, body: unknown, id = rfqId) {
  return request(testApp.app).put(sendPath(id)).set('Cookie', cookie).send(body);
}

const statusesOf = (body: SendRfqResponse) => body.mails.map((mail) => mail.status);

describe('PUT /v1/mailbox/rfqs/:rfqId/send', () => {
  it('creates the rfq and sends one fresh-thread mail per contact with the text of the vendor category and the signature', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp, 'Bhatia Logistics');
    const vendors = await seedVendors(testApp, scope.cookie);

    const response = await send(testApp, scope.cookie, everyoneBody(vendors));

    expect(response.status).toBe(200);
    const body = sendRfqResponseSchema.parse(response.body);
    expect(body.rfq).toMatchObject({
      id: rfqId,
      sourceEmailId: customerEmailId,
      originPort: 'Hazira, India',
      destinationPort: 'Jebel Ali, UAE',
      incoterm: 'FOB',
      status: 'open',
    });
    expect(statusesOf(body)).toEqual(['sent', 'sent', 'sent']);
    expect(body.mails.map((mail) => mail.toRecipients[0]!.address)).toEqual([
      'asha.rao@sealines.example',
      'ben.lee@sealines.example',
      'chitra.nair@portclearers.example',
    ]);
    expect(body.mails.map((mail) => mail.subject)).toEqual([
      'RFQ: carrier rates',
      'RFQ: carrier rates',
      'RFQ: clearance',
    ]);
    expect(body.mails.map((mail) => mail.vendorId)).toEqual([
      vendors.carrierId,
      vendors.carrierId,
      vendors.chaId,
    ]);
    expect(body.mails.map((mail) => mail.vendorContactId)).toEqual([
      ...vendors.carrierContactIds,
      vendors.chaContactId,
    ]);
    expect(body.mails.every((mail) => mail.kind === 'rfq' && mail.rfqId === rfqId)).toBe(true);
    expect(body.mails.every((mail) => mail.inReplyToEmailId === null)).toBe(true);
    expect(new Set(body.mails.map((mail) => mail.gmailThreadId)).size).toBe(3);

    const sentMessages = testApp.gmailSender.sentMessages;
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages.every((sent) => sent.threadId === undefined)).toBe(true);
    expect(sentMessages.every((sent) => sent.message.signature === 'Bhatia Logistics')).toBe(true);
    expect(sentMessages.every((sent) => sent.message.inReplyTo === undefined)).toBe(true);
    expect(sentMessages.map((sent) => sent.message.messageId)).toEqual(
      body.mails.map((mail) => mail.rfcMessageId),
    );
    expect(sentMessages.map((sent) => sent.message.to[0]!.name)).toEqual([
      'Asha Rao',
      'Ben Lee',
      'Chitra Nair',
    ]);
  });

  it('is idempotent: the same PUT again sends nothing and reports the same mails', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    const first = await send(testApp, scope.cookie, everyoneBody(vendors));

    const second = await send(testApp, scope.cookie, everyoneBody(vendors));

    expect(second.status).toBe(200);
    expect(second.body.mails.map((mail: { id: string }) => mail.id)).toEqual(
      first.body.mails.map((mail: { id: string }) => mail.id),
    );
    expect(testApp.gmailSender.sentMessages).toHaveLength(3);
  });

  it('keeps going past a refusal, and the same PUT again resends only the failed mail', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    testApp.gmailSender.failNextSendWith = 'bad_request';

    const first = await send(testApp, scope.cookie, everyoneBody(vendors));

    expect(first.status).toBe(200);
    const firstBody = sendRfqResponseSchema.parse(first.body);
    expect(statusesOf(firstBody).sort()).toEqual(['failed', 'sent', 'sent']);
    const failed = firstBody.mails.find((mail) => mail.status === 'failed')!;
    expect(failed.errorCode).toBe('bad_request');
    expect(testApp.gmailSender.sentMessages).toHaveLength(2);

    const second = await send(testApp, scope.cookie, everyoneBody(vendors));

    const secondBody = sendRfqResponseSchema.parse(second.body);
    expect(statusesOf(secondBody)).toEqual(['sent', 'sent', 'sent']);
    const retried = secondBody.mails.find((mail) => mail.id === failed.id)!;
    expect(retried.errorCode).toBeNull();
    expect(testApp.gmailSender.sentMessages).toHaveLength(3);
    expect(testApp.gmailSender.sentMessages[2]!.message.messageId).toBe(failed.rfcMessageId);
  });

  it('sends to a contact added on a later PUT without touching the mails already sent', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    const carrierOnly = {
      ...everyoneBody(vendors),
      recipients: [{ vendorId: vendors.carrierId, contactIds: [vendors.carrierContactIds[0]] }],
    };
    await send(testApp, scope.cookie, carrierOnly);

    const widened = await send(testApp, scope.cookie, everyoneBody(vendors));

    expect(statusesOf(sendRfqResponseSchema.parse(widened.body))).toEqual(['sent', 'sent', 'sent']);
    expect(testApp.gmailSender.sentMessages).toHaveLength(3);
  });

  it('stops the batch on a dead refresh token, flags the mailbox and leaves the rest pending', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    testApp.gmailSender.failNextSendWith = 'invalid_grant';

    const response = await send(testApp, scope.cookie, everyoneBody(vendors));

    expect(response.status).toBe(200);
    const body = sendRfqResponseSchema.parse(response.body);
    // Two sends were in flight when the first failed: one failed, one went through, the third never started.
    expect(statusesOf(body).sort()).toEqual(['failed', 'pending', 'sent']);
    expect(
      (await testApp.repositories.mailboxConnectionRepository.findMailboxConnection(scope))!
        .gmailConnectionStatus,
    ).toBe('needs_reconnect');
  });

  it('leaves the row in sending when the outcome is unknown and does not retry it', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    testApp.gmailSender.failNextSendWith = 'request_failed';

    const first = await send(testApp, scope.cookie, everyoneBody(vendors));
    expect(statusesOf(sendRfqResponseSchema.parse(first.body)).sort()).toEqual([
      'sending',
      'sent',
      'sent',
    ]);

    const second = await send(testApp, scope.cookie, everyoneBody(vendors));
    expect(statusesOf(sendRfqResponseSchema.parse(second.body)).sort()).toEqual([
      'sending',
      'sent',
      'sent',
    ]);
    expect(testApp.gmailSender.sentMessages).toHaveLength(2);
  });

  it('refuses before writing anything when a vendor, a contact or the mail is unknown or archived, or a category has no text', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    const body = everyoneBody(vendors);

    const cases: [unknown, number, string][] = [
      [{ ...body, sourceEmailId: unknownId }, 404, 'email_not_found'],
      [
        { ...body, recipients: [{ vendorId: vendors.archivedVendorId, contactIds: [unknownId] }] },
        404,
        'vendor_not_found',
      ],
      [
        {
          ...body,
          recipients: [
            { vendorId: vendors.carrierId, contactIds: [vendors.archivedCarrierContactId] },
          ],
        },
        404,
        'contact_not_found',
      ],
      [
        {
          ...body,
          recipients: [{ vendorId: vendors.carrierId, contactIds: [vendors.chaContactId] }],
        },
        404,
        'contact_not_found',
      ],
      [{ ...body, mails: [mails[0]] }, 400, 'missing_mail_text'],
    ];
    for (const [requestBody, status, error] of cases) {
      const response = await send(testApp, scope.cookie, requestBody);
      expect([response.status, response.body.error]).toEqual([status, error]);
    }
    expect(await testApp.repositories.rfqRepository.findRfq(scope, rfqId)).toBeUndefined();
    expect(testApp.gmailSender.sentMessages).toHaveLength(0);
  });

  it('answers 409 when the mailbox is not connected or the id was used for another mail', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    testApp.repositories.addEmail({
      ...scope,
      id: customerEmailId,
      gmailThreadId: '1a1c',
      gmailLabel: 'inbox',
      senderName: 'Ravi Kumar',
      senderEmail: 'ravi@acme.com',
      toRecipients: [{ name: '', address: testMailboxEmail }],
      subject: 'RFQ',
      snippet: '',
      receivedAt: new Date('2026-11-10T10:00:00Z'),
    });
    const notConnected = await send(testApp, scope.cookie, everyoneBody(vendors));
    expect([notConnected.status, notConnected.body.error]).toEqual([409, 'mailbox_not_connected']);

    await testApp.repositories.mailboxConnectionRepository.saveGmailConnection(scope, {
      encryptedRefreshToken: testApp.encryptionUtil.encryptSecret('refresh-token-1'),
      lastHistoryId: 1n,
      watchExpiresAt: new Date('2026-11-20T00:00:00Z'),
    });
    await send(testApp, scope.cookie, everyoneBody(vendors));
    const otherEmailId = '00000000-0000-4000-8000-000000000002';
    testApp.repositories.addEmail({
      ...scope,
      id: otherEmailId,
      gmailThreadId: '2b2d',
      gmailLabel: 'inbox',
      senderName: 'Someone Else',
      senderEmail: 'else@acme.com',
      toRecipients: [{ name: '', address: testMailboxEmail }],
      subject: 'Another request',
      snippet: '',
      receivedAt: new Date('2026-11-11T10:00:00Z'),
    });
    const reused = await send(testApp, scope.cookie, {
      ...everyoneBody(vendors),
      sourceEmailId: otherEmailId,
    });
    expect([reused.status, reused.body.error]).toEqual([409, 'rfq_id_taken']);
  });

  it('requires a session and a well-formed id', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);

    const anonymous = await request(testApp.app).put(sendPath(rfqId)).send(everyoneBody(vendors));
    expect(anonymous.status).toBe(401);
    const badId = await send(testApp, scope.cookie, everyoneBody(vendors), 'not-a-uuid');
    expect(badId.status).toBe(404);
  });
});

describe('GET /v1/mailbox/rfqs/:rfqId', () => {
  it('returns the rfq and its mails exactly as the send reported them', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    const sent = await send(testApp, scope.cookie, everyoneBody(vendors));

    const read = await request(testApp.app).get(rfqPath(rfqId)).set('Cookie', scope.cookie);

    expect(read.status).toBe(200);
    expect(getRfqResponseSchema.parse(read.body)).toEqual(sent.body);
    expect(testApp.gmailSender.sentMessages).toHaveLength(3);
  });

  it('reports, per contact, how many mails answered ours and the newest of them with its label', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    const sent = await send(testApp, scope.cookie, everyoneBody(vendors));
    const [ashaMail, benMail] = (sent.body as SendRfqResponse).mails;
    const ackId = '00000000-0000-4000-8000-00000000000a';
    const quoteId = '00000000-0000-4000-8000-00000000000b';
    const classifiedAt = new Date('2026-11-16T09:31:00Z');
    testApp.repositories.addEmail({
      ...scope,
      id: ackId,
      gmailThreadId: ashaMail!.gmailThreadId!,
      gmailLabel: 'inbox',
      senderName: 'Asha Rao',
      senderEmail: 'asha.rao@sealines.example',
      toRecipients: [{ name: '', address: testMailboxEmail }],
      subject: 'Re: RFQ: carrier rates',
      snippet: 'Received, will revert',
      receivedAt: new Date('2026-11-16T09:00:00Z'),
      answersSentMailId: ashaMail!.id,
    });
    testApp.repositories.addEmail({
      ...scope,
      id: quoteId,
      gmailThreadId: ashaMail!.gmailThreadId!,
      gmailLabel: 'inbox',
      senderName: 'Asha Rao',
      senderEmail: 'asha.rao@sealines.example',
      toRecipients: [{ name: '', address: testMailboxEmail }],
      subject: 'Re: RFQ: carrier rates',
      snippet: 'USD 1450 per 40ft, valid 7 days',
      receivedAt: new Date('2026-11-16T09:30:00Z'),
      answersSentMailId: ashaMail!.id,
      classification: { label: 'vendor_quote', source: 'llm', confidence: 0.9, classifiedAt },
    });

    const read = await request(testApp.app).get(rfqPath(rfqId)).set('Cookie', scope.cookie);

    expect(read.status).toBe(200);
    const body = getRfqResponseSchema.parse(read.body);
    expect(body.mails.map((mail) => mail.replies)).toEqual([
      {
        count: 2,
        latest: {
          emailId: quoteId,
          sender: { name: 'Asha Rao', email: 'asha.rao@sealines.example' },
          receivedAt: '2026-11-16T09:30:00.000Z',
          snippet: 'USD 1450 per 40ft, valid 7 days',
          classification: {
            label: 'vendor_quote',
            source: 'llm',
            confidence: 0.9,
            classifiedAt: classifiedAt.toISOString(),
          },
        },
      },
      { count: 0, latest: null },
      { count: 0, latest: null },
    ]);
    expect(body.mails[1]!.id).toBe(benMail!.id);
  });

  it('answers 404 for an unknown or malformed id, another mailbox, and 401 without a session', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    await send(testApp, scope.cookie, everyoneBody(vendors));

    const unknown = await request(testApp.app).get(rfqPath(unknownId)).set('Cookie', scope.cookie);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'rfq_not_found' });
    const malformed = await request(testApp.app)
      .get(rfqPath('not-a-uuid'))
      .set('Cookie', scope.cookie);
    expect(malformed.status).toBe(404);
    const anonymous = await request(testApp.app).get(rfqPath(rfqId));
    expect(anonymous.status).toBe(401);

    const otherTenant = await request(testApp.app)
      .post('/v1/tenants')
      .send({ ...testTenantBody, name: 'Other Forwarder' });
    const otherEmail = 'other@example.com';
    await request(testApp.app)
      .post(`/v1/tenants/${otherTenant.body.tenantId}/mailboxes`)
      .send({ email: otherEmail, password });
    const otherLogin = await request(testApp.app)
      .post('/v1/auth/login')
      .send({ email: otherEmail, password });
    const otherSetCookie = otherLogin.headers['set-cookie'];
    const otherCookie = (
      Array.isArray(otherSetCookie) ? otherSetCookie : [String(otherSetCookie)]
    ).find((cookie) => cookie.startsWith('lc_session='))!;
    const foreign = await request(testApp.app).get(rfqPath(rfqId)).set('Cookie', otherCookie);
    expect(foreign.status).toBe(404);
  });
});

describe('GET /v1/mailbox/rfqs/bySourceEmail/:emailId', () => {
  it('finds the RFQ sent from a customer mail and answers exactly as GET /rfqs/:rfqId does', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    await send(testApp, scope.cookie, everyoneBody(vendors));

    const byEmail = await request(testApp.app)
      .get(rfqBySourceEmailPath(customerEmailId))
      .set('Cookie', scope.cookie);
    const byRfqId = await request(testApp.app).get(rfqPath(rfqId)).set('Cookie', scope.cookie);

    expect(byEmail.status).toBe(200);
    const body = getRfqBySourceEmailResponseSchema.parse(byEmail.body);
    expect(body.rfq.id).toBe(rfqId);
    expect(body.rfq.sourceEmailId).toBe(customerEmailId);
    expect(body.mails).toHaveLength(3);
    expect(body).toEqual(byRfqId.body);
  });

  it('returns the newest RFQ when the same customer mail was processed twice', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    const laterRfqId = '22222222-2222-4222-8222-222222222223';
    await send(testApp, scope.cookie, everyoneBody(vendors));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await send(testApp, scope.cookie, everyoneBody(vendors), laterRfqId);

    const byEmail = await request(testApp.app)
      .get(rfqBySourceEmailPath(customerEmailId))
      .set('Cookie', scope.cookie);

    expect(byEmail.status).toBe(200);
    expect(getRfqBySourceEmailResponseSchema.parse(byEmail.body).rfq.id).toBe(laterRfqId);
  });

  it('answers 404 rfq_not_found for a mail with no RFQ, a malformed id and another mailbox, 401 without a session', async () => {
    const testApp = createTestApp();
    const scope = await connectedMailbox(testApp);
    const vendors = await seedVendors(testApp, scope.cookie);
    await send(testApp, scope.cookie, everyoneBody(vendors));

    const noRfq = await request(testApp.app)
      .get(rfqBySourceEmailPath(unknownId))
      .set('Cookie', scope.cookie);
    expect(noRfq.status).toBe(404);
    expect(noRfq.body).toEqual({ error: 'rfq_not_found' });
    const malformed = await request(testApp.app)
      .get(rfqBySourceEmailPath('not-a-uuid'))
      .set('Cookie', scope.cookie);
    expect(malformed.status).toBe(404);
    const anonymous = await request(testApp.app).get(rfqBySourceEmailPath(customerEmailId));
    expect(anonymous.status).toBe(401);

    const otherTenant = await request(testApp.app)
      .post('/v1/tenants')
      .send({ ...testTenantBody, name: 'Other Forwarder' });
    const otherEmail = 'other@example.com';
    await request(testApp.app)
      .post(`/v1/tenants/${otherTenant.body.tenantId}/mailboxes`)
      .send({ email: otherEmail, password });
    const otherLogin = await request(testApp.app)
      .post('/v1/auth/login')
      .send({ email: otherEmail, password });
    const otherSetCookie = otherLogin.headers['set-cookie'];
    const otherCookie = (
      Array.isArray(otherSetCookie) ? otherSetCookie : [String(otherSetCookie)]
    ).find((cookie) => cookie.startsWith('lc_session='))!;
    const foreign = await request(testApp.app)
      .get(rfqBySourceEmailPath(customerEmailId))
      .set('Cookie', otherCookie);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: 'rfq_not_found' });
  });
});
