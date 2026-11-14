import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const inboxEmailId = '00000000-0000-4000-8000-000000000001';
const earlierThreadEmailId = '00000000-0000-4000-8000-000000000002';
const sentEmailId = '00000000-0000-4000-8000-000000000003';
const sentMailId = '11111111-1111-4111-8111-111111111111';
const repliesPath = (emailId: string) => `/v1/mailbox/emails/${emailId}/replies`;

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
    id: sentEmailId,
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
    await request(testApp.app)
      .patch('/v1/mailbox/signature')
      .set('Cookie', cookie)
      .send({ signature: 'Ops Desk' });

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
      (await agent.post(repliesPath(sentEmailId)).set('Cookie', cookie).send(body)).body.error,
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
