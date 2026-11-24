import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { OUTBOUND_ATTACHMENT_MAX_BYTES } from '@lc/contract';
import type { OutboundAttachmentResponse } from '@lc/contract';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { tinyPng, uploadSignatureImage } from '../signatureImageFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const inboxEmailId = '00000000-0000-4000-8000-000000000001';
const earlierThreadEmailId = '00000000-0000-4000-8000-000000000002';
const outboundFixtureEmailId = '00000000-0000-4000-8000-000000000003';
const sentMailId = '11111111-1111-4111-8111-111111111111';
const repliesPath = (answeredEmailId: string) => `/v1/mailbox/emails/${answeredEmailId}/replies`;

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

/** A thread: an earlier mail from us (sent), the vendor's inbox mail we answer, plus an unrelated sent mail. */
function seedThread(testApp: TestApp, scope: { mailboxId: string; tenantId: string }): void {
  const base = {
    senderName: 'Ravi Kumar',
    senderEmail: 'ravi@acme.com',
    toRecipients: [{ name: '', address: testMailboxEmail }],
    snippet: '',
    receivedAt: new Date('2026-11-10T10:00:00Z'),
  };
  testApp.repositories.addEmail({
    ...scope,
    ...base,
    id: earlierThreadEmailId,
    gmailThreadId: 'thread-1',
    gmailLabel: 'sent',
    senderName: '',
    senderEmail: testMailboxEmail,
    subject: 'RFQ 123: Mumbai to Rotterdam',
    rfcMessageId: '<first@bhatia.example>',
    receivedAt: new Date('2026-11-09T10:00:00Z'),
  });
  testApp.repositories.addEmail({
    ...scope,
    ...base,
    id: inboxEmailId,
    gmailThreadId: 'thread-1',
    gmailLabel: 'inbox',
    subject: 'Re: RFQ 123: Mumbai to Rotterdam',
    rfcMessageId: '<vendor-reply@acme.com>',
  });
  testApp.repositories.addEmail({
    ...scope,
    ...base,
    id: outboundFixtureEmailId,
    gmailThreadId: 'thread-2',
    gmailLabel: 'sent',
    subject: 'Something we sent',
  });
}

async function connectedMailbox(testApp: TestApp) {
  const session = await signedInMailbox(testApp);
  await testApp.repositories.mailboxConnectionRepository.saveGmailConnection(session, {
    encryptedRefreshToken: testApp.encryptionUtil.encryptSecret('refresh-token-1'),
    lastHistoryId: 1n,
    watchExpiresAt: new Date('2026-11-20T00:00:00Z'),
  });
  seedThread(testApp, session);
  return session;
}

describe('POST /v1/mailbox/emails/:emailId/replies', () => {
  it('writes the row, sends the reply into the original thread with our Message-ID, and returns 201 sent', async () => {
    const testApp = createTestApp();
    const { cookie, mailboxId } = await connectedMailbox(testApp);
    const logo = await uploadSignatureImage(testApp.app, cookie, tinyPng, 'image/png', 'logo.png');
    await request(testApp.app)
      .patch('/v1/mailbox/signature')
      .set('Cookie', cookie)
      .send({ signatureHtml: `<p>Ops Desk</p><img src="cid:${logo.contentId}">` });

    const response = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.', cc: [{ address: 'desk@bhatia.example' }] });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: sentMailId,
      kind: 'reply',
      status: 'sent',
      inReplyToEmailId: inboxEmailId,
      gmailThreadId: 'thread-1',
      rfcMessageId: `<${sentMailId}@bhatia.example>`,
      toRecipients: [{ name: 'Ravi Kumar', address: 'ravi@acme.com' }],
      ccRecipients: [{ name: '', address: 'desk@bhatia.example' }],
      subject: 'Re: RFQ 123: Mumbai to Rotterdam',
      bodyText: 'Rates attached.',
      gmailMessageId: 'fake-gmail-message-1',
      errorCode: null,
    });

    expect(testApp.gmailSender.sentMessages).toHaveLength(1);
    const [sent] = testApp.gmailSender.sentMessages;
    expect(sent.refreshToken).toBe('refresh-token-1');
    expect(sent.threadId).toBe('thread-1');
    expect(sent.message).toEqual({
      from: { name: '', address: testMailboxEmail },
      to: [{ name: 'Ravi Kumar', address: 'ravi@acme.com' }],
      cc: [{ name: '', address: 'desk@bhatia.example' }],
      subject: 'Re: RFQ 123: Mumbai to Rotterdam',
      text: 'Rates attached.',
      signature: 'Ops Desk',
      signatureHtml: `<p>Ops Desk</p><img src="cid:${logo.contentId}" />`,
      // The signature's image travels with the mail as an inline part, bytes from the bucket.
      inlineImages: [
        { contentId: logo.id, content: tinyPng, contentType: 'image/png', fileName: 'logo.png' },
      ],
      messageId: `<${sentMailId}@bhatia.example>`,
      inReplyTo: '<vendor-reply@acme.com>',
      references: ['<first@bhatia.example>', '<vendor-reply@acme.com>'],
    });
    expect(
      await testApp.repositories.sentMailRepository.findSentMail(
        {
          mailboxId,
          tenantId: (await request(testApp.app).get('/v1/me').set('Cookie', cookie)).body.tenantId,
        },
        sentMailId,
      ),
    ).toMatchObject({ status: 'sent', gmailThreadId: 'thread-1' });
  });

  it('replays an already-seen sentMailId with 200 and does not send again', async () => {
    const testApp = createTestApp();
    const { cookie } = await connectedMailbox(testApp);
    const first = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.' });
    const second = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(testApp.gmailSender.sentMessages).toHaveLength(1);
  });

  it('resumes a row left pending by a crash before sending, and sends it exactly once', async () => {
    const testApp = createTestApp();
    const { cookie, ...scope } = await connectedMailbox(testApp);
    const stuck = await testApp.repositories.sentMailRepository.createPending(scope, {
      id: sentMailId,
      kind: 'reply',
      inReplyToEmailId: inboxEmailId,
      gmailThreadId: 'thread-1',
      rfcMessageId: `<${sentMailId}@bhatia.example>`,
      toRecipients: [{ name: 'Ravi Kumar', address: 'ravi@acme.com' }],
      ccRecipients: [],
      subject: 'Re: RFQ 123: Mumbai to Rotterdam',
      bodyText: 'Rates attached.',
    });
    expect(stuck.outcome).toBe('created');

    const resumed = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.' });
    expect(resumed.status).toBe(201);
    expect(resumed.body.status).toBe('sent');
    expect(testApp.gmailSender.sentMessages).toHaveLength(1);
  });

  it('keeps the row as failed with the Gmail error code and answers 502; invalid_grant also flags the mailbox', async () => {
    const testApp = createTestApp();
    const { cookie } = await connectedMailbox(testApp);
    testApp.gmailSender.failNextSendWith = 'rate_limited';
    const failed = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.' });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe('send_failed');
    expect(failed.body.sentMail).toMatchObject({
      id: sentMailId,
      status: 'failed',
      errorCode: 'rate_limited',
    });
    expect(
      (await request(testApp.app).get('/v1/mailbox').set('Cookie', cookie)).body
        .gmailConnectionStatus,
    ).toBe('connected');

    testApp.gmailSender.failNextSendWith = 'invalid_grant';
    const dead = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId: '22222222-2222-4222-8222-222222222222', text: 'Again.' });
    expect(dead.status).toBe(502);
    expect(dead.body.sentMail.errorCode).toBe('invalid_grant');
    expect(
      (await request(testApp.app).get('/v1/mailbox').set('Cookie', cookie)).body
        .gmailConnectionStatus,
    ).toBe('needs_reconnect');
  });

  it('leaves the row in sending when the outcome is unknown (no HTTP response), so nothing invites a duplicate', async () => {
    const testApp = createTestApp();
    const { cookie, ...scope } = await connectedMailbox(testApp);
    testApp.gmailSender.failNextSendWith = 'request_failed';
    const unknown = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.' });
    expect(unknown.status).toBe(502);
    expect(unknown.body.sentMail).toMatchObject({
      id: sentMailId,
      status: 'sending',
      errorCode: null,
    });
    expect(
      await testApp.repositories.sentMailRepository.findSentMail(scope, sentMailId),
    ).toMatchObject({ status: 'sending' });
  });

  it('refuses a sent mail, an unknown or foreign mail, a mailbox without Gmail, and a bad body', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const me = (await request(testApp.app).get('/v1/me').set('Cookie', cookie)).body;
    seedThread(testApp, me);
    const agent = request(testApp.app);
    const body = { sentMailId, text: 'Hello' };

    expect(
      (await agent.post(repliesPath(inboxEmailId)).set('Cookie', cookie).send(body)).status,
    ).toBe(409);
    expect(
      (await agent.post(repliesPath(inboxEmailId)).set('Cookie', cookie).send(body)).body.error,
    ).toBe('mailbox_not_connected');
    await testApp.repositories.mailboxConnectionRepository.saveGmailConnection(me, {
      encryptedRefreshToken: testApp.encryptionUtil.encryptSecret('refresh-token-1'),
      lastHistoryId: 1n,
      watchExpiresAt: new Date('2026-11-20T00:00:00Z'),
    });
    expect(
      (await agent.post(repliesPath(outboundFixtureEmailId)).set('Cookie', cookie).send(body)).body
        .error,
    ).toBe('not_inbound');
    expect(
      (
        await agent
          .post(repliesPath('00000000-0000-4000-8000-00000000ffff'))
          .set('Cookie', cookie)
          .send(body)
      ).status,
    ).toBe(404);
    expect(
      (await agent.post(repliesPath('not-a-uuid')).set('Cookie', cookie).send(body)).status,
    ).toBe(404);
    expect(
      (await agent.post(repliesPath(inboxEmailId)).set('Cookie', cookie).send({ text: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (
        await agent
          .post(repliesPath(inboxEmailId))
          .set('Cookie', cookie)
          .send({ sentMailId, text: '   ' })
      ).status,
    ).toBe(400);
    expect((await agent.post(repliesPath(inboxEmailId)).send(body)).status).toBe(401);
    expect(testApp.gmailSender.sentMessages).toHaveLength(0);
  });
});

const tinyPdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(16, 0)]);
const csv = Buffer.from('container,eta\nMSKU1234567,2026-12-01\n', 'utf8');

async function uploadOutboundAttachment(
  testApp: TestApp,
  cookie: string,
  content: Buffer,
  fileName: string,
  contentType: string,
): Promise<OutboundAttachmentResponse> {
  const response = await request(testApp.app)
    .post('/v1/mailbox/outbound-attachments')
    .query({ fileName })
    .set('Cookie', cookie)
    .set('Content-Type', contentType)
    .send(content);
  if (response.status !== 201) {
    throw new Error(`upload failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

describe('POST /v1/mailbox/emails/:emailId/replies with attachmentIds', () => {
  it('sends the uploads as attachments in the order given, stamps them with the row once Gmail took it, and lists them', async () => {
    const testApp = createTestApp();
    const { cookie, ...scope } = await connectedMailbox(testApp);
    const rateCard = await uploadOutboundAttachment(
      testApp,
      cookie,
      tinyPdf,
      'Rate card.pdf',
      'application/pdf',
    );
    const eta = await uploadOutboundAttachment(testApp, cookie, csv, 'eta.csv', 'text/csv');

    const response = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.', attachmentIds: [rateCard.id, eta.id] });

    expect(response.status).toBe(201);
    expect(response.body.attachments).toEqual([rateCard, eta]);
    const [sent] = testApp.gmailSender.sentMessages;
    expect(sent.message.attachments).toEqual([
      { content: tinyPdf, contentType: 'application/pdf', fileName: 'Rate card.pdf' },
      { content: csv, contentType: 'text/csv', fileName: 'eta.csv' },
    ]);
    expect(
      await testApp.repositories.outboundAttachmentRepository.listOutboundAttachmentsOfSentMail(
        scope,
        sentMailId,
      ),
    ).toHaveLength(2);
    // Stamped files can no longer be deleted from the composer.
    expect(
      (
        await request(testApp.app)
          .delete(`/v1/mailbox/outbound-attachments/${rateCard.id}`)
          .set('Cookie', cookie)
      ).status,
    ).toBe(404);

    // A replay keeps the files it was stamped with, whatever the body says now.
    const replay = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.', attachmentIds: [] });
    expect(replay.status).toBe(200);
    expect(replay.body.attachments).toEqual([rateCard, eta]);
    expect(testApp.gmailSender.sentMessages).toHaveLength(1);
  });

  it('resumes a row left pending with the files the body names', async () => {
    const testApp = createTestApp();
    const { cookie, ...scope } = await connectedMailbox(testApp);
    const rateCard = await uploadOutboundAttachment(
      testApp,
      cookie,
      tinyPdf,
      'Rate card.pdf',
      'application/pdf',
    );
    await testApp.repositories.sentMailRepository.createPending(scope, {
      id: sentMailId,
      kind: 'reply',
      inReplyToEmailId: inboxEmailId,
      gmailThreadId: 'thread-1',
      rfcMessageId: `<${sentMailId}@bhatia.example>`,
      toRecipients: [{ name: 'Ravi Kumar', address: 'ravi@acme.com' }],
      ccRecipients: [],
      subject: 'Re: RFQ 123: Mumbai to Rotterdam',
      bodyText: 'Rates attached.',
    });

    const resumed = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.', attachmentIds: [rateCard.id] });
    expect(resumed.status).toBe(201);
    expect(resumed.body.attachments).toEqual([rateCard]);
    expect(testApp.gmailSender.sentMessages[0].message.attachments).toHaveLength(1);
  });

  it('sends a reply without attachmentIds exactly as before', async () => {
    const testApp = createTestApp();
    const { cookie } = await connectedMailbox(testApp);
    const response = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.' });
    expect(response.status).toBe(201);
    expect(response.body.attachments).toEqual([]);
    expect(testApp.gmailSender.sentMessages[0].message).not.toHaveProperty('attachments');
  });

  it('refuses an unknown or foreign id, a file already on another mail, a total past the limit, duplicates, and files without a bucket', async () => {
    const testApp = createTestApp();
    const { cookie, ...scope } = await connectedMailbox(testApp);
    const agent = request(testApp.app);
    const rateCard = await uploadOutboundAttachment(
      testApp,
      cookie,
      tinyPdf,
      'Rate card.pdf',
      'application/pdf',
    );
    const send = (sentMailIdForSend: string, attachmentIds: string[]) =>
      agent
        .post(repliesPath(inboxEmailId))
        .set('Cookie', cookie)
        .send({ sentMailId: sentMailIdForSend, text: 'Rates attached.', attachmentIds });

    const unknown = await send(sentMailId, ['00000000-0000-4000-8000-00000000dead']);
    expect(unknown.status).toBe(409);
    expect(unknown.body.error).toBe('attachment_not_found');

    const duplicate = await send(sentMailId, [rateCard.id, rateCard.id]);
    expect(duplicate.status).toBe(400);

    const otherMailId = '22222222-2222-4222-8222-222222222222';
    await testApp.repositories.outboundAttachmentRepository.attachToSentMail(
      scope,
      [rateCard.id],
      otherMailId,
    );
    const alreadySent = await send(sentMailId, [rateCard.id]);
    expect(alreadySent.status).toBe(409);
    expect(alreadySent.body.error).toBe('attachment_already_sent');

    const big = await uploadOutboundAttachment(
      testApp,
      cookie,
      Buffer.alloc(OUTBOUND_ATTACHMENT_MAX_BYTES, 1),
      'big-1.bin',
      'application/octet-stream',
    );
    const bigger = await uploadOutboundAttachment(
      testApp,
      cookie,
      Buffer.alloc(OUTBOUND_ATTACHMENT_MAX_BYTES, 2),
      'big-2.bin',
      'application/octet-stream',
    );
    const tooLarge = await send(sentMailId, [big.id, bigger.id]);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error).toBe('attachments_too_large');

    // Nothing above reached the write-ahead row or Gmail.
    expect(
      await testApp.repositories.sentMailRepository.findSentMail(scope, sentMailId),
    ).toBeUndefined();
    expect(testApp.gmailSender.sentMessages).toHaveLength(0);

    const noBucket = createTestApp({ outboundAttachmentsEnabled: false });
    const session = await connectedMailbox(noBucket);
    const unavailable = await request(noBucket.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', session.cookie)
      .send({ sentMailId, text: 'Rates attached.', attachmentIds: [rateCard.id] });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toBe('outbound_attachments_unavailable');
  });

  it('leaves the files unsent when Gmail refuses the mail, so the retry under a new id carries them', async () => {
    const testApp = createTestApp();
    const { cookie, ...scope } = await connectedMailbox(testApp);
    const rateCard = await uploadOutboundAttachment(
      testApp,
      cookie,
      tinyPdf,
      'Rate card.pdf',
      'application/pdf',
    );
    testApp.gmailSender.failNextSendWith = 'rate_limited';
    const refused = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.', attachmentIds: [rateCard.id] });
    expect(refused.status).toBe(502);
    expect(refused.body.sentMail).toMatchObject({ status: 'failed', attachments: [] });
    expect(
      await testApp.repositories.outboundAttachmentRepository.findOutboundAttachments(scope, [
        rateCard.id,
      ]),
    ).toMatchObject([{ sentMailId: null }]);

    const retryId = '22222222-2222-4222-8222-222222222222';
    const retried = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId: retryId, text: 'Rates attached.', attachmentIds: [rateCard.id] });
    expect(retried.status).toBe(201);
    expect(retried.body.attachments).toEqual([rateCard]);
    expect(
      await testApp.repositories.outboundAttachmentRepository.findOutboundAttachments(scope, [
        rateCard.id,
      ]),
    ).toMatchObject([{ sentMailId: retryId }]);
    expect(testApp.gmailSender.sentMessages).toHaveLength(1);
  });

  it('fails the row and answers 409 when a file is removed between the check and the read, before anything reaches Gmail', async () => {
    const testApp = createTestApp();
    const { cookie, ...scope } = await connectedMailbox(testApp);
    const rateCard = await uploadOutboundAttachment(
      testApp,
      cookie,
      tinyPdf,
      'Rate card.pdf',
      'application/pdf',
    );
    const repository = testApp.repositories.outboundAttachmentRepository;
    const findOutboundAttachments = repository.findOutboundAttachments.bind(repository);
    repository.findOutboundAttachments = async (findScope, attachmentIds) => {
      const found = await findOutboundAttachments(findScope, attachmentIds);
      // The composer's delete lands right after the send's check: row and object both gone.
      await repository.deleteUnsentOutboundAttachment(findScope, rateCard.id);
      testApp.outboundAttachmentStore.objects.clear();
      return found;
    };

    const response = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.', attachmentIds: [rateCard.id] });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('attachment_not_found');
    expect(
      await testApp.repositories.sentMailRepository.findSentMail(scope, sentMailId),
    ).toMatchObject({ status: 'failed', errorCode: 'attachment_not_found' });
    expect(testApp.gmailSender.sentMessages).toHaveLength(0);
  });

  it('still sends when a file row is removed after the bytes were read, and lists only what was stamped', async () => {
    const testApp = createTestApp();
    const { cookie } = await connectedMailbox(testApp);
    const rateCard = await uploadOutboundAttachment(
      testApp,
      cookie,
      tinyPdf,
      'Rate card.pdf',
      'application/pdf',
    );
    const store = testApp.outboundAttachmentStore;
    const readAttachment = store.readAttachment.bind(store);
    store.readAttachment = async (attachment) => {
      const content = await readAttachment(attachment);
      // The composer's delete lands after the bytes are in hand.
      const session = (await request(testApp.app).get('/v1/me').set('Cookie', cookie)).body;
      await testApp.repositories.outboundAttachmentRepository.deleteUnsentOutboundAttachment(
        session,
        rateCard.id,
      );
      return content;
    };

    const response = await request(testApp.app)
      .post(repliesPath(inboxEmailId))
      .set('Cookie', cookie)
      .send({ sentMailId, text: 'Rates attached.', attachmentIds: [rateCard.id] });
    expect(response.status).toBe(201);
    expect(response.body.attachments).toEqual([]);
    expect(testApp.gmailSender.sentMessages[0].message.attachments).toEqual([
      { content: tinyPdf, contentType: 'application/pdf', fileName: 'Rate card.pdf' },
    ]);
  });
});
