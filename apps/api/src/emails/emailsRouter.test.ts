import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';
import { DEFAULT_EMAIL_PAGE_SIZE } from './emailsRouter.js';

const password = 'a-long-enough-password';

/** A valid uuid whose last group is the index, so expectations can name rows by index. */
function emailId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

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

/** n emails one minute apart, newest = index 0; uuids with the index in the last group so ties sort by index. */
function seedEmails(
  testApp: TestApp,
  scope: { mailboxId: string; tenantId: string },
  count: number,
  overrides: { gmailLabel?: 'inbox' | 'sent'; receivedAt?: Date } = {},
): void {
  for (let index = 0; index < count; index += 1) {
    testApp.repositories.addEmail({
      ...scope,
      id: emailId(index),
      gmailThreadId: `thread-${index}`,
      gmailLabel: overrides.gmailLabel ?? (index % 2 === 0 ? 'inbox' : 'sent'),
      senderName: 'Ravi Kumar',
      senderEmail: 'ravi@acme.com',
      toRecipients: [{ name: '', address: testMailboxEmail }],
      subject: `RFQ ${index}`,
      snippet: `Need a quote ${index}`,
      receivedAt: overrides.receivedAt ?? new Date(Date.UTC(2026, 10, 9, 12, 59 - index)),
    });
  }
}

describe('GET /v1/mailbox/emails', () => {
  it('lists the session mailbox newest first with the list fields only, and requires a session', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedEmails(testApp, scope, 2);
    testApp.repositories.addEmail({
      mailboxId: 'someone-else',
      tenantId: scope.tenantId,
      id: emailId(999),
      gmailThreadId: 'thread-other',
      gmailLabel: 'inbox',
      senderName: '',
      senderEmail: null,
      toRecipients: [],
      subject: 'not yours',
      snippet: '',
      receivedAt: new Date('2026-11-09T13:30:00Z'),
    });

    const response = await request(testApp.app)
      .get('/v1/mailbox/emails')
      .set('Cookie', scope.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      mailboxId: scope.mailboxId,
      tenantId: scope.tenantId,
      emails: [
        {
          id: emailId(0),
          gmailThreadId: 'thread-0',
          gmailLabel: 'inbox',
          sender: { name: 'Ravi Kumar', email: 'ravi@acme.com' },
          toRecipients: [{ name: '', address: testMailboxEmail }],
          subject: 'RFQ 0',
          snippet: 'Need a quote 0',
          receivedAt: '2026-11-09T12:59:00.000Z',
        },
        expect.objectContaining({ id: emailId(1), gmailLabel: 'sent' }),
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(response.body)).not.toContain('body');
    expect((await request(testApp.app).get('/v1/mailbox/emails')).status).toBe(401);
  });

  it('pages with an opaque cursor: no gaps, no repeats, null cursor on the last page', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedEmails(testApp, scope, 5);

    const first = await request(testApp.app)
      .get('/v1/mailbox/emails?limit=2')
      .set('Cookie', scope.cookie);
    expect(first.body.emails.map((email: { id: string }) => email.id)).toEqual([
      emailId(0),
      emailId(1),
    ]);
    expect(first.body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const second = await request(testApp.app)
      .get(`/v1/mailbox/emails?limit=2&cursor=${first.body.nextCursor}`)
      .set('Cookie', scope.cookie);
    expect(second.body.emails.map((email: { id: string }) => email.id)).toEqual([
      emailId(2),
      emailId(3),
    ]);

    const third = await request(testApp.app)
      .get(`/v1/mailbox/emails?limit=2&cursor=${second.body.nextCursor}`)
      .set('Cookie', scope.cookie);
    expect(third.body.emails.map((email: { id: string }) => email.id)).toEqual([emailId(4)]);
    expect(third.body.nextCursor).toBeNull();
  });

  it('breaks ties on received_at by id so same-second mail pages correctly', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedEmails(testApp, scope, 3, { receivedAt: new Date('2026-11-09T12:00:00Z') });

    const first = await request(testApp.app)
      .get('/v1/mailbox/emails?limit=2')
      .set('Cookie', scope.cookie);
    const second = await request(testApp.app)
      .get(`/v1/mailbox/emails?limit=2&cursor=${first.body.nextCursor}`)
      .set('Cookie', scope.cookie);

    const ids = [...first.body.emails, ...second.body.emails].map(
      (email: { id: string }) => email.id,
    );
    expect(ids).toEqual([emailId(2), emailId(1), emailId(0)]);
  });

  it('filters by label', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedEmails(testApp, scope, 4);

    const sent = await request(testApp.app)
      .get('/v1/mailbox/emails?label=sent')
      .set('Cookie', scope.cookie);

    expect(sent.body.emails.map((email: { id: string }) => email.id)).toEqual([
      emailId(1),
      emailId(3),
    ]);
  });

  it('defaults the page size and caps it at 100', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedEmails(testApp, scope, DEFAULT_EMAIL_PAGE_SIZE + 1);

    const defaulted = await request(testApp.app)
      .get('/v1/mailbox/emails')
      .set('Cookie', scope.cookie);
    expect(defaulted.body.emails).toHaveLength(DEFAULT_EMAIL_PAGE_SIZE);
    expect(defaulted.body.nextCursor).not.toBeNull();

    const tooLarge = await request(testApp.app)
      .get('/v1/mailbox/emails?limit=101')
      .set('Cookie', scope.cookie);
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error).toMatch(/^invalid_query: limit/);
  });

  it.each([
    ['a cursor that is not ours', 'cursor=not-a-cursor', 'invalid_cursor'],
    ['a label it does not know', 'label=drafts', 'invalid_query: label'],
    ['a non-numeric limit', 'limit=ten', 'invalid_query: limit'],
  ])('400 for %s', async (_name, query, errorPrefix) => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);

    const response = await request(testApp.app)
      .get(`/v1/mailbox/emails?${query}`)
      .set('Cookie', scope.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.startsWith(errorPrefix)).toBe(true);
  });
});

describe('GET /v1/mailbox/emails/:emailId', () => {
  it('returns bodies, cc and the current classification; null when never classified', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedEmails(testApp, scope, 2);
    testApp.repositories.addEmail({
      ...scope,
      id: emailId(7),
      gmailThreadId: 'abc123',
      gmailLabel: 'inbox',
      senderName: 'Ravi Kumar',
      senderEmail: 'ravi@acme.com',
      toRecipients: [{ name: '', address: testMailboxEmail }],
      ccRecipients: [{ name: 'Boss', address: 'boss@acme.com' }],
      subject: 'RFQ',
      snippet: 'Need a quote',
      receivedAt: new Date('2026-11-10T10:00:00Z'),
      rfcMessageId: '<rfq-7@acme.com>',
      bodyText: 'Need a quote for 2 x 40ft.',
      bodyHtml: '<p>Need a quote for 2 x 40ft.</p>',
    });
    testApp.repositories.setClassification(emailId(7), {
      label: 'customer_request',
      source: 'llm',
      confidence: 0.93,
      classifiedAt: new Date('2026-11-10T10:00:05Z'),
    });

    const classified = await request(testApp.app)
      .get(`/v1/mailbox/emails/${emailId(7)}`)
      .set('Cookie', scope.cookie);
    expect(classified.status).toBe(200);
    expect(classified.body).toEqual({
      id: emailId(7),
      gmailThreadId: 'abc123',
      gmailLabel: 'inbox',
      sender: { name: 'Ravi Kumar', email: 'ravi@acme.com' },
      toRecipients: [{ name: '', address: testMailboxEmail }],
      ccRecipients: [{ name: 'Boss', address: 'boss@acme.com' }],
      subject: 'RFQ',
      snippet: 'Need a quote',
      receivedAt: '2026-11-10T10:00:00.000Z',
      rfcMessageId: '<rfq-7@acme.com>',
      bodyText: 'Need a quote for 2 x 40ft.',
      bodyHtml: '<p>Need a quote for 2 x 40ft.</p>',
      classification: {
        label: 'customer_request',
        source: 'llm',
        confidence: 0.93,
        classifiedAt: '2026-11-10T10:00:05.000Z',
      },
    });

    const unclassified = await request(testApp.app)
      .get(`/v1/mailbox/emails/${emailId(0)}`)
      .set('Cookie', scope.cookie);
    expect(unclassified.status).toBe(200);
    expect(unclassified.body).toMatchObject({ id: emailId(0), classification: null, bodyText: '' });
  });

  it('answers 404 for an unknown id, a malformed id and another mailbox, and 401 without a session', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedEmails(testApp, scope, 1);
    testApp.repositories.addEmail({
      mailboxId: '11111111-1111-4111-8111-111111111111',
      tenantId: scope.tenantId,
      id: emailId(9),
      gmailThreadId: 'other',
      gmailLabel: 'inbox',
      senderName: '',
      senderEmail: null,
      toRecipients: [],
      subject: '',
      snippet: '',
      receivedAt: new Date('2026-11-10T10:00:00Z'),
    });

    for (const id of [emailId(5), 'not-a-uuid', emailId(9)]) {
      const response = await request(testApp.app)
        .get(`/v1/mailbox/emails/${id}`)
        .set('Cookie', scope.cookie);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'not_found' });
    }
    expect((await request(testApp.app).get(`/v1/mailbox/emails/${emailId(0)}`)).status).toBe(401);
  });
});

describe('GET /v1/mailbox/threads/:gmailThreadId', () => {
  it('returns every stored message of the thread in this mailbox, inbox and sent, oldest first', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    const thread = (index: number, gmailLabel: 'inbox' | 'sent', minute: number) =>
      testApp.repositories.addEmail({
        ...scope,
        id: emailId(index),
        gmailThreadId: '1a1c6f27c3b30c33',
        gmailLabel,
        senderName: gmailLabel === 'inbox' ? 'Ravi Kumar' : 'Ops Desk',
        senderEmail: gmailLabel === 'inbox' ? 'ravi@acme.com' : testMailboxEmail,
        toRecipients: [],
        subject: 'RFQ',
        snippet: `message ${index}`,
        receivedAt: new Date(Date.UTC(2026, 10, 10, 10, minute)),
        bodyText: `message ${index}`,
      });
    thread(2, 'inbox', 20);
    thread(0, 'inbox', 0);
    thread(1, 'sent', 10);
    seedEmails(testApp, scope, 1); // another thread, must not appear
    testApp.repositories.setClassification(emailId(0), {
      label: 'customer_request',
      source: 'llm',
      confidence: 1,
      classifiedAt: new Date('2026-11-10T10:00:05Z'),
    });
    testApp.repositories.setClassification(emailId(2), {
      label: 'customer_reply',
      source: 'thread',
      confidence: null,
      classifiedAt: new Date('2026-11-10T10:20:05Z'),
    });

    const response = await request(testApp.app)
      .get('/v1/mailbox/threads/1a1c6f27c3b30c33')
      .set('Cookie', scope.cookie);

    expect(response.status).toBe(200);
    expect(response.body.gmailThreadId).toBe('1a1c6f27c3b30c33');
    expect(
      response.body.emails.map(
        (email: { id: string; gmailLabel: string; classification: unknown }) => [
          email.id,
          email.gmailLabel,
          email.classification && (email.classification as { label: string }).label,
        ],
      ),
    ).toEqual([
      [emailId(0), 'inbox', 'customer_request'],
      [emailId(1), 'sent', null],
      [emailId(2), 'inbox', 'customer_reply'],
    ]);
    expect(response.body.emails[2].classification.source).toBe('thread');
  });

  it('answers 404 for a thread with no stored mail in this mailbox and for a malformed id', async () => {
    const testApp = createTestApp();
    const scope = await signedInMailbox(testApp);
    seedEmails(testApp, scope, 1);
    // Same mailbox id under another tenant: tenantId is the isolation check, not just the mailbox.
    testApp.repositories.addEmail({
      mailboxId: scope.mailboxId,
      tenantId: '22222222-2222-4222-8222-222222222222',
      id: emailId(9),
      gmailThreadId: 'deadbeef',
      gmailLabel: 'inbox',
      senderName: '',
      senderEmail: null,
      toRecipients: [],
      subject: '',
      snippet: '',
      receivedAt: new Date('2026-11-10T10:00:00Z'),
    });

    expect(
      (
        await request(testApp.app)
          .get(`/v1/mailbox/emails/${emailId(9)}`)
          .set('Cookie', scope.cookie)
      ).status,
    ).toBe(404);
    for (const threadId of ['deadbeef', 'thread-0!', 'Thread-0']) {
      const response = await request(testApp.app)
        .get(`/v1/mailbox/threads/${threadId}`)
        .set('Cookie', scope.cookie);
      expect(response.status).toBe(404);
    }
    expect((await request(testApp.app).get('/v1/mailbox/threads/deadbeef')).status).toBe(401);
  });
});
