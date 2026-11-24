import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendRfqBody } from '@lc/contract';
import {
  ClassificationOutcomeUnknownError,
  FrontendApiError,
  RFQ_PAGE_SIZE,
  errorMessage,
  frontendApi,
} from './frontendApi.js';

const session = {
  mailboxId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('frontendApi', () => {
  it('sends login to a relative URL with the cookie and parses the shared contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(session)));
    vi.stubGlobal('fetch', fetchMock);
    expect(await frontendApi.login('ops@example.com', 'password')).toEqual(session);
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/auth/login',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
        method: 'POST',
        body: JSON.stringify({ email: 'ops@example.com', password: 'password' }),
      }),
    );
  });
  it('treats only a 401 session response as signed out, not a server outage', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 401 }))
        .mockImplementation(async () => new Response('proxy failed', { status: 502 })),
    );
    expect(await frontendApi.session()).toBeNull();
    const outage = expect(frontendApi.session()).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(1_500);
    await outage;
  });
  it('handles an empty logout response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(frontendApi.logout()).resolves.toBeUndefined();
  });
  it('rejects malformed response data and non-Google redirect targets', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ emails: [] })))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ url: 'https://evil.example/phishing' })),
        ),
    );
    await expect(frontendApi.emails(session, {}, undefined)).rejects.toThrow();
    await expect(frontendApi.connect()).rejects.toThrow();
  });
  it('encodes cursor/filter and passes AbortSignal without any mailbox identifier', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ ...session, emails: [], nextCursor: null })),
      );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await frontendApi.emails(session, { label: 'sent' }, 'a+b/c', controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/mailbox/emails?limit=30&label=sent&cursor=a%2Bb%2Fc',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal.aborted).toBe(false);

    await frontendApi.emails(
      session,
      { label: 'inbox', classification: 'customer_request' },
      undefined,
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/v1/mailbox/emails?limit=30&label=inbox&classification=customer_request',
      expect.anything(),
    );
  });
  it.each(['mailboxId', 'tenantId'] as const)(
    'rejects mailbox and mail responses when the cookie changed %s',
    async (identityField) => {
      const switchedSession = {
        ...session,
        [identityField]: '00000000-0000-4000-8000-000000000009',
      };
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                ...switchedSession,
                emailAddress: 'sales@example.com',
                gmailConnectionStatus: 'connected',
                gmailConnectedAt: null,
                watchExpiresAt: null,
                signature: null,
                signatureHtml: null,
              }),
            ),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                ...switchedSession,
                emails: [],
                nextCursor: null,
              }),
            ),
          ),
      );
      await expect(frontendApi.mailbox(session)).rejects.toMatchObject({ code: 'session_changed' });
      await expect(frontendApi.emails(session, {}, undefined)).rejects.toMatchObject({
        code: 'session_changed',
      });
    },
  );
  it('preserves a safe API error code for the UI without rendering server output', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'invalid_credentials' }), { status: 401 }),
        ),
    );
    await expect(frontendApi.login('ops@example.com', 'wrong')).rejects.toEqual(
      new FrontendApiError(401, 'invalid_credentials'),
    );
  });
});

const emailId = '00000000-0000-4000-8000-000000000011';
const message = {
  id: emailId,
  gmailThreadId: 'abc123',
  gmailLabel: 'inbox',
  sender: { name: 'Ravi', email: 'ravi@example.com' },
  toRecipients: [],
  ccRecipients: [],
  subject: 'Quote',
  snippet: '',
  receivedAt: '2026-11-09T12:00:00.000Z',
  rfcMessageId: null,
  bodyText: 'Please quote.',
  bodyHtml: null,
  classification: null,
};
function mockResponses(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
describe('list classifications', () => {
  it('preserves labels from the list response without a detail request', async () => {
    const classification = {
      label: 'customer_reply',
      source: 'thread',
      confidence: null,
      classifiedAt: '2026-11-09T13:00:00.000Z',
    };
    const fetchMock = mockResponses({
      ...session,
      emails: [{ ...message, classification }],
      nextCursor: null,
    });
    const response = await frontendApi.emails(session, { label: 'inbox' }, undefined);
    expect(response.emails[0]?.classification).toEqual(classification);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('thread and attachments', () => {
  it('anchors the thread to the selected email, validates the session and propagates cancellation', async () => {
    const thread = { gmailThreadId: 'abc123', emails: [message] };
    const fetchMock = mockResponses(message, thread, session);
    const controller = new AbortController();
    expect(await frontendApi.thread(session, emailId, controller.signal)).toEqual(thread);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      `/v1/mailbox/emails/${emailId}`,
      '/v1/mailbox/threads/abc123',
      '/v1/me',
    ]);
    for (const [, options] of fetchMock.mock.calls)
      expect(options).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });

    const pendingFetch = vi.fn(
      (_path: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    vi.stubGlobal('fetch', pendingFetch);
    const cancelled = new AbortController();
    const pending = frontendApi.thread(session, emailId, cancelled.signal);
    cancelled.abort(new Error('navigated'));
    await expect(pending).rejects.toThrow('navigated');
    expect(pendingFetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(pendingFetch).toHaveBeenCalledTimes(1);
  });
  it('rejects a thread from another mailbox even when the Gmail thread id matches', async () => {
    mockResponses(message, {
      gmailThreadId: 'abc123',
      emails: [{ ...message, id: session.mailboxId }],
    });
    await expect(frontendApi.thread(session, emailId)).rejects.toMatchObject({
      code: 'session_changed',
    });
  });
  it('rejects a switched identity after the thread arrives', async () => {
    mockResponses(
      message,
      { gmailThreadId: 'abc123', emails: [message] },
      { ...session, mailboxId: emailId },
    );
    await expect(frontendApi.thread(session, emailId)).rejects.toMatchObject({
      code: 'session_changed',
    });
  });
  it('rejects a mismatched detail id before reading the thread', async () => {
    const fetchMock = mockResponses({ ...message, id: session.mailboxId });
    await expect(frontendApi.thread(session, emailId)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('validates attachment ownership and the session', async () => {
    const body = { emailId, attachments: [] };
    mockResponses(body, session);
    expect(await frontendApi.attachments(session, emailId)).toEqual(body);
    mockResponses({ ...body, emailId: session.mailboxId });
    await expect(frontendApi.attachments(session, emailId)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    mockResponses(body, { ...session, tenantId: emailId });
    await expect(frontendApi.attachments(session, emailId)).rejects.toMatchObject({
      code: 'session_changed',
    });
  });
  it.each([
    'javascript:alert(1)',
    'http://bucket.example/file',
    'https://user:pass@bucket.example/file',
  ])('rejects unsafe download target %s', async (url) => {
    mockResponses({ url, expiresAt: '2026-11-09T12:05:00.000Z' });
    await expect(frontendApi.attachmentDownload(session, emailId, 'file-id')).rejects.toMatchObject(
      { code: 'invalid_download_url' },
    );
  });
  it('requests a fresh HTTPS link and verifies identity before handing it to the UI', async () => {
    const body = { url: 'https://bucket.example/file', expiresAt: '2026-11-09T12:05:00.000Z' };
    mockResponses(body, session);
    expect(await frontendApi.attachmentDownload(session, emailId, 'file-id')).toEqual(body);
    mockResponses(body, { ...session, mailboxId: emailId });
    await expect(frontendApi.attachmentDownload(session, emailId, 'file-id')).rejects.toMatchObject(
      { code: 'session_changed' },
    );
  });
});

describe('scoped mail 404 after an account switch', () => {
  it.each(['thread', 'attachments', 'attachmentDownload'] as const)(
    'checks identity on a %s 404',
    async (operation) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(new Response('{}', { status: 404 }))
          .mockResolvedValueOnce(new Response(JSON.stringify({ ...session, mailboxId: emailId }))),
      );
      const pending =
        operation === 'attachmentDownload'
          ? frontendApi.attachmentDownload(session, emailId, 'file-id')
          : frontendApi[operation](session, emailId);
      await expect(pending).rejects.toMatchObject({ code: 'session_changed', status: 401 });
    },
  );
  it('posts for an RFQ suggestion, parses it and verifies the session afterwards', async () => {
    const suggestion = {
      originPort: 'Nhava Sheva',
      destinationPort: null,
      senderAddress: null,
      receiverAddress: null,
      mode: 'sea_freight',
      containers: [{ type: '40ft', quantity: 1 }],
      commodity: null,
      grossWeightKg: null,
      volumeCbm: null,
      incoterm: 'FOB',
      readyDate: null,
      specialInstructions: null,
      model: 'm',
      promptVersion: 'v1',
    };
    const fetchMock = mockResponses(suggestion, session);
    expect(await frontendApi.rfqSuggestion(session, emailId)).toEqual(suggestion);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/v1/mailbox/emails/${emailId}/rfq-suggestion`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v1/me', expect.anything());
    mockResponses(suggestion, { ...session, mailboxId: emailId });
    await expect(frontendApi.rfqSuggestion(session, emailId)).rejects.toMatchObject({
      code: 'session_changed',
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'suggestion_failed' }), { status: 422 }),
        ),
    );
    await expect(frontendApi.rfqSuggestion(session, emailId)).rejects.toMatchObject({
      status: 422,
      code: 'suggestion_failed',
    });
  });
  it('lists vendors and drafts RFQ mails, verifying the session after each', async () => {
    const vendors = { vendors: [] };
    let fetchMock = mockResponses(vendors, session);
    expect(await frontendApi.vendors(session)).toEqual(vendors);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/v1/mailbox/vendors', expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v1/me', expect.anything());
    mockResponses(vendors, { ...session, tenantId: emailId });
    await expect(frontendApi.vendors(session)).rejects.toMatchObject({ code: 'session_changed' });

    const body = {
      sourceEmailId: emailId,
      details: { originPort: 'A', destinationPort: 'B' },
      vendorIds: ['00000000-0000-4000-8000-000000000021'],
    };
    const drafts = {
      drafts: [
        { category: 'carrier', subject: 'RFQ', bodyText: 'Hello', model: 'm', promptVersion: 'v1' },
      ],
    };
    fetchMock = mockResponses(drafts, session);
    expect(await frontendApi.rfqDrafts(session, body)).toEqual(drafts);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/v1/mailbox/rfqs/drafts',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'vendor_not_found' }), { status: 404 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify(session))),
    );
    await expect(frontendApi.rfqDrafts(session, body)).rejects.toMatchObject({
      status: 404,
      code: 'vendor_not_found',
    });
  });
  it('sends an RFQ with a single PUT and reads it back, verifying the session and the id', async () => {
    const rfqId = '00000000-0000-4000-8000-000000000077';
    const mail = {
      id: '00000000-0000-4000-8000-000000000078',
      kind: 'rfq',
      status: 'sent',
      inReplyToEmailId: null,
      rfqId,
      vendorId: '00000000-0000-4000-8000-000000000021',
      vendorContactId: '00000000-0000-4000-8000-000000000031',
      gmailThreadId: 't1',
      rfcMessageId: '<x@example.com>',
      toRecipients: [{ name: 'Ravi', address: 'ravi@example.com' }],
      ccRecipients: [],
      subject: 'RFQ',
      bodyText: 'Hello',
      gmailMessageId: 'm1',
      errorCode: null,
      attachments: [],
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
      replies: { count: 0, latest: null },
    };
    const result = {
      rfq: {
        id: rfqId,
        sourceEmailId: emailId,
        originPort: 'A',
        destinationPort: 'B',
        incoterm: null,
        status: 'open',
        createdAt: '2026-11-16T00:00:00.000Z',
        updatedAt: '2026-11-16T00:00:00.000Z',
      },
      mails: [mail],
      attachments: [],
    };
    const body: SendRfqBody = {
      sourceEmailId: emailId,
      details: { originPort: 'A', destinationPort: 'B' },
      recipients: [{ vendorId: mail.vendorId, contactIds: [mail.vendorContactId] }],
      mails: [{ category: 'carrier', subject: 'RFQ', bodyText: 'Hello' }],
    };
    let fetchMock = mockResponses(result, session);
    expect(await frontendApi.sendRfq(session, rfqId, body)).toEqual(result);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/v1/mailbox/rfqs/${rfqId}/send`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(body) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v1/me', expect.anything());

    // A send is never replayed by the transport: one failed attempt is the answer.
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const failing = frontendApi.sendRfq(session, rfqId, body);
    const settled = failing.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await settled).toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    fetchMock = mockResponses(result, session);
    expect(await frontendApi.rfq(session, rfqId)).toEqual(result);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/v1/mailbox/rfqs/${rfqId}`,
      expect.not.objectContaining({ method: 'PUT' }),
    );
    mockResponses({ ...result, rfq: { ...result.rfq, id: emailId } }, session);
    await expect(frontendApi.rfq(session, rfqId)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    mockResponses(result, { ...session, tenantId: emailId });
    await expect(frontendApi.sendRfq(session, rfqId, body)).rejects.toMatchObject({
      code: 'session_changed',
    });
  });
  it('preserves a genuine 404 when the cookie still belongs to the same account', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 404 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(session))),
    );
    await expect(frontendApi.thread(session, emailId)).rejects.toMatchObject({ status: 404 });
  });
  it('finds the RFQ sent from a mail, null when none was, and refuses one for another mail', async () => {
    const rfqId = '00000000-0000-4000-8000-000000000077';
    const result = {
      rfq: {
        id: rfqId,
        sourceEmailId: emailId,
        originPort: 'A',
        destinationPort: 'B',
        incoterm: null,
        status: 'open',
        createdAt: '2026-11-16T00:00:00.000Z',
        updatedAt: '2026-11-16T00:00:00.000Z',
      },
      mails: [],
      attachments: [],
    };
    let fetchMock = mockResponses(result, session);
    expect(await frontendApi.rfqBySourceEmail(session, emailId)).toEqual(result);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/v1/mailbox/rfqs/bySourceEmail/${emailId}`,
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v1/me', expect.anything());

    // No RFQ yet: the 404 is checked against the session, then answered as null, not thrown.
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'rfq_not_found' }), { status: 404 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(session)));
    vi.stubGlobal('fetch', fetchMock);
    expect(await frontendApi.rfqBySourceEmail(session, emailId)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The same 404 after another tab switched accounts is a sign-out, not "no RFQ".
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 404 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...session, mailboxId: emailId }))),
    );
    await expect(frontendApi.rfqBySourceEmail(session, emailId)).rejects.toMatchObject({
      code: 'session_changed',
    });

    mockResponses({ ...result, rfq: { ...result.rfq, sourceEmailId: rfqId } }, session);
    await expect(frontendApi.rfqBySourceEmail(session, emailId)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('lists RFQs a page at a time, passing the cursor back and verifying the session', async () => {
    const page = {
      customerMails: [
        {
          sourceEmail: {
            id: emailId,
            sender: { name: 'Ravi', email: 'ravi@acme.example' },
            subject: 'RFQ',
            receivedAt: '2026-11-15T09:00:00.000Z',
          },
          rfqs: [
            {
              rfq: {
                id: '00000000-0000-4000-8000-000000000077',
                sourceEmailId: emailId,
                originPort: 'A',
                destinationPort: 'B',
                incoterm: null,
                status: 'open',
                createdAt: '2026-11-16T00:00:00.000Z',
                updatedAt: '2026-11-16T00:00:00.000Z',
              },
              replies: { contactCount: 3, repliedCount: 1, quoteCount: 0 },
            },
          ],
        },
      ],
      nextCursor: 'opaque-cursor',
    };
    let fetchMock = mockResponses(page, session);
    expect(await frontendApi.rfqs(session, undefined)).toEqual(page);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/v1/mailbox/rfqs?limit=${RFQ_PAGE_SIZE}`,
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v1/me', expect.anything());

    fetchMock = mockResponses({ ...page, nextCursor: null }, session);
    await frontendApi.rfqs(session, 'opaque-cursor');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/v1/mailbox/rfqs?limit=${RFQ_PAGE_SIZE}&cursor=opaque-cursor`,
      expect.anything(),
    );

    mockResponses(page, { ...session, tenantId: emailId });
    await expect(frontendApi.rfqs(session, undefined)).rejects.toMatchObject({
      code: 'session_changed',
    });
  });
});

describe('transport retries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  const unavailable = () =>
    new Response(JSON.stringify({ error: 'attachments_unavailable' }), { status: 503 });

  it('retries a read three times and keeps the final status and code', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => unavailable());
    vi.stubGlobal('fetch', fetchMock);
    const pending = frontendApi.attachments(session, emailId);
    const assertion = expect(pending).rejects.toEqual(
      new FrontendApiError(503, 'attachments_unavailable'),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('recovers when a read succeeds after a transient failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify(session)));
    vi.stubGlobal('fetch', fetchMock);
    const pending = frontendApi.session();
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['login', () => frontendApi.login('ops@example.com', 'password')],
    ['logout', () => frontendApi.logout()],
    ['connect', () => frontendApi.connect()],
  ] as const)('replays the reviewed %s POST', async (_name, call) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const assertion = expect(call()).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('forwards cancellation on the reviewed POSTs', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = frontendApi.logout(controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('unmounted'));
    await expect(pending).rejects.toThrow('unmounted');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry schema failures, session failures or permanent errors', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{"emails":[]}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(frontendApi.emails(session, {}, undefined)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const switched = mockResponses({ ...session, tenantId: emailId, emails: [], nextCursor: null });
    await expect(frontendApi.emails(session, {}, undefined)).rejects.toMatchObject({
      code: 'session_changed',
    });
    expect(switched).toHaveBeenCalledTimes(1);

    const unauthenticated = vi
      .fn()
      .mockImplementation(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', unauthenticated);
    await expect(frontendApi.session()).resolves.toBeNull();
    expect(unauthenticated).toHaveBeenCalledTimes(1);

    const malformed = vi.fn().mockImplementation(async () => new Response('<html>'));
    vi.stubGlobal('fetch', malformed);
    await expect(frontendApi.session()).rejects.toThrow(SyntaxError);
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it('keeps API requests free of a deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(new Response(JSON.stringify(session))), 60_000),
          ),
      ),
    );
    const pending = frontendApi.session();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toEqual(session);
  });
});

describe('classification correction', () => {
  const correction = {
    label: 'customer_reply',
    source: 'user',
    confidence: null,
    classifiedAt: '2026-11-13T09:00:00.000Z',
  } as const;

  it('checks the cookie before and after a non-replaying POST, validates the response', async () => {
    const fetchMock = mockResponses(session, correction, session);
    const controller = new AbortController();
    await expect(
      frontendApi.correctClassification(session, emailId, 'customer_reply', controller.signal),
    ).resolves.toEqual(correction);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/v1/me',
      `/v1/mailbox/emails/${emailId}/classifications`,
      '/v1/me',
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ label: 'customer_reply' }),
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    });
  });

  it.each(['tenantId', 'mailboxId'] as const)(
    'rejects a cookie switch of %s before the write',
    async (field) => {
      const fetchMock = mockResponses({ ...session, [field]: emailId });
      await expect(frontendApi.correctClassification(session, emailId, 'general')).rejects.toEqual(
        new FrontendApiError(401, 'session_changed'),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('does not attempt a POST when the preflight identity read fails', async () => {
    const unavailable = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', unavailable);
    await expect(frontendApi.correctClassification(session, emailId, 'rate_card')).rejects.toEqual(
      new FrontendApiError(401, 'request_failed'),
    );
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it('treats a postflight outage as unknown without trying another POST', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(new Response(JSON.stringify(correction)))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const pending = frontendApi.correctClassification(session, emailId, 'customer_reply');
      const rejected = expect(pending).rejects.toEqual(new ClassificationOutcomeUnknownError());
      await vi.advanceTimersByTimeAsync(1_500);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/v1/me',
      `/v1/mailbox/emails/${emailId}/classifications`,
      '/v1/me',
      '/v1/me',
      '/v1/me',
    ]);
  });

  it('rejects an account switch after the write without returning cross-account data', async () => {
    const fetchMock = mockResponses(session, correction, { ...session, tenantId: emailId });
    await expect(
      frontendApi.correctClassification(session, emailId, 'customer_reply'),
    ).rejects.toMatchObject({ code: 'session_changed' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('checks identity on a scoped 404 but preserves a genuine missing-message error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...session, mailboxId: emailId })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(frontendApi.correctClassification(session, emailId, 'rate_card')).rejects.toEqual(
      new FrontendApiError(401, 'session_changed'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const unchanged = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(session)));
    vi.stubGlobal('fetch', unchanged);
    await expect(frontendApi.correctClassification(session, emailId, 'rate_card')).rejects.toEqual(
      new FrontendApiError(404, 'not_found'),
    );
    expect(unchanged).toHaveBeenCalledTimes(3);
  });

  it.each(['503', 'network'] as const)(
    'preserves a correction 404 when its identity recheck fails with %s',
    async (failure) => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(session)))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }),
        )
        .mockImplementation(async () => {
          if (failure === 'network') throw new TypeError('Connection reset');
          return new Response('{}', { status: 503 });
        });
      vi.stubGlobal('fetch', fetchMock);
      const rejected = expect(
        frontendApi.correctClassification(session, emailId, 'rate_card'),
      ).rejects.toEqual(new FrontendApiError(404, 'not_found'));
      await vi.advanceTimersByTimeAsync(1_500);
      await rejected;
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        '/v1/me',
        `/v1/mailbox/emails/${emailId}/classifications`,
        '/v1/me',
        '/v1/me',
        '/v1/me',
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('propagates an expired session during a correction 404 identity recheck', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'not_authenticated' }), { status: 401 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(frontendApi.correctClassification(session, emailId, 'general')).rejects.toEqual(
      new FrontendApiError(401, 'not_authenticated'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves cancellation during a correction 404 identity recheck', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
      .mockImplementationOnce(async () => {
        controller.abort(new Error('navigated'));
        return new Response('{}', { status: 503 });
      });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      frontendApi.correctClassification(session, emailId, 'general', controller.signal),
    ).rejects.toThrow('navigated');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not replay a 503 or a lost response because even a confirmation appends a row', async () => {
    const failed = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }),
      );
    vi.stubGlobal('fetch', failed);
    await expect(frontendApi.correctClassification(session, emailId, 'general')).rejects.toEqual(
      new ClassificationOutcomeUnknownError(),
    );
    expect(failed).toHaveBeenCalledTimes(2);
    const disconnected = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockRejectedValueOnce(new TypeError('Connection reset'));
    vi.stubGlobal('fetch', disconnected);
    await expect(frontendApi.correctClassification(session, emailId, 'general')).rejects.toEqual(
      new ClassificationOutcomeUnknownError(),
    );
    expect(disconnected).toHaveBeenCalledTimes(2);
  });

  it('rejects a response that disagrees with the appended user label', async () => {
    const wrongLabel = mockResponses(session, correction, session);
    await expect(frontendApi.correctClassification(session, emailId, 'rate_card')).rejects.toEqual(
      new ClassificationOutcomeUnknownError(),
    );
    expect(wrongLabel).toHaveBeenCalledTimes(3);
    const wrongSource = mockResponses(session, { ...correction, source: 'llm' }, session);
    await expect(
      frontendApi.correctClassification(session, emailId, 'customer_reply'),
    ).rejects.toEqual(new ClassificationOutcomeUnknownError());
    expect(wrongSource).toHaveBeenCalledTimes(3);
  });

  it('does not accept an invalid response or aborted request as a saved classification', async () => {
    const invalid = mockResponses(session, { ...correction, label: 'not_a_label' });
    await expect(frontendApi.correctClassification(session, emailId, 'general')).rejects.toThrow();
    expect(invalid).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    const aborted = mockResponses(session);
    controller.abort(new Error('navigated'));
    await expect(
      frontendApi.correctClassification(session, emailId, 'general', controller.signal),
    ).rejects.toThrow('navigated');
    expect(aborted).toHaveBeenCalledTimes(0);
  });
});

describe('signature and its images', () => {
  const mailbox = {
    ...session,
    emailAddress: 'ops@example.com',
    gmailConnectionStatus: 'connected',
    gmailConnectedAt: '2026-11-01T09:00:00.000Z',
    watchExpiresAt: '2026-11-08T09:00:00.000Z',
    signature: 'Ops Desk',
    signatureHtml: '<p>Ops Desk</p>',
  };
  const image = {
    id: '00000000-0000-4000-8000-000000000031',
    fileName: 'logo.png',
    contentType: 'image/png',
    sizeBytes: 3,
    contentId: '00000000-0000-4000-8000-000000000031',
    previewUrl: 'https://bucket.example/signatures/logo.png?X-Amz-Signature=abc',
    previewUrlExpiresAt: '2026-11-20T10:15:00.000Z',
    createdAt: '2026-11-20T10:00:00.000Z',
  };

  it('PATCHes the signature as JSON and returns the sanitised mailbox for this session', async () => {
    const fetchMock = mockResponses(mailbox);
    expect(await frontendApi.updateSignature(session, '<p>Ops Desk<script></script></p>')).toEqual(
      mailbox,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/mailbox/signature',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ signatureHtml: '<p>Ops Desk<script></script></p>' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const otherAccount = mockResponses({ ...mailbox, mailboxId: image.id });
    await expect(frontendApi.updateSignature(session, null)).rejects.toMatchObject({
      status: 401,
      code: 'session_changed',
    });
    expect(otherAccount.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ signatureHtml: null }),
    });
  });

  it('lists images and checks the cookie still belongs to this session', async () => {
    const fetchMock = mockResponses({ images: [image] }, session);
    expect(await frontendApi.signatureImages(session)).toEqual({ images: [image] });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/v1/mailbox/signature/images',
      '/v1/me',
    ]);
    mockResponses({ images: [image] }, { ...session, tenantId: image.id });
    await expect(frontendApi.signatureImages(session)).rejects.toMatchObject({
      code: 'session_changed',
    });
  });

  it('uploads the raw bytes with the file type and name, never as JSON', async () => {
    const fetchMock = mockResponses(image, session);
    const file = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
    expect(await frontendApi.uploadSignatureImage(session, file)).toEqual(image);
    const [path, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/v1/mailbox/signature/images?fileName=logo.png');
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: file,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/v1/me');

    const unnamed = mockResponses(image, session);
    await frontendApi.uploadSignatureImage(
      session,
      new File([new Uint8Array(3)], '', { type: 'image/gif' }),
    );
    expect(unnamed.mock.calls[0]?.[0]).toBe('/v1/mailbox/signature/images');
  });

  it('refuses an unsupported type or oversized file before any request is made', async () => {
    const fetchMock = mockResponses(image, session);
    const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
    await expect(frontendApi.uploadSignatureImage(session, svg)).rejects.toMatchObject({
      status: 415,
      code: 'unsupported_image_type',
    });
    const huge = new File([new Uint8Array(200 * 1024 + 1)], 'photo.jpg', { type: 'image/jpeg' });
    await expect(frontendApi.uploadSignatureImage(session, huge)).rejects.toMatchObject({
      status: 413,
      code: 'image_too_large',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not replay an upload whose first attempt failed with a retryable status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([new Uint8Array(3)], 'logo.png', { type: 'image/png' });
    await expect(frontendApi.uploadSignatureImage(session, file)).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deletes an image, accepts the empty response and surfaces an in-use refusal', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(session)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(frontendApi.deleteSignatureImage(session, image.id)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      `/v1/mailbox/signature/images/${image.id}`,
      '/v1/me',
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'signature_image_in_use' }), { status: 409 }),
        ),
    );
    const refusal = frontendApi.deleteSignatureImage(session, image.id);
    await expect(refusal).rejects.toMatchObject({ status: 409, code: 'signature_image_in_use' });
    await expect(refusal.catch((error: unknown) => errorMessage(error))).resolves.toBe(
      'This image is still in your signature. Remove it from the signature first.',
    );
  });
});

describe('reply attachments', () => {
  const attachment = {
    id: '00000000-0000-4000-8000-00000000000a',
    fileName: 'Rate card.pdf',
    contentType: 'application/pdf',
    sizeBytes: 3,
    createdAt: '2026-11-22T10:00:00.000Z',
  };

  it('uploads the raw bytes with the file type and name, octet-stream when the browser has no type', async () => {
    const fetchMock = mockResponses(attachment, session);
    const file = new File([new Uint8Array([1, 2, 3])], 'Rate card.pdf', {
      type: 'application/pdf',
    });
    expect(await frontendApi.uploadOutboundAttachment(session, file)).toEqual(attachment);
    const [path, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/v1/mailbox/outbound-attachments?fileName=Rate+card.pdf');
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: file,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/v1/me');

    const untyped = mockResponses(attachment, session);
    await frontendApi.uploadOutboundAttachment(session, new File([new Uint8Array(3)], 'eta.dat'));
    expect(untyped.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });

  it('refuses an empty, oversized or Gmail-blocked file before any request is made', async () => {
    const fetchMock = mockResponses(attachment, session);
    await expect(
      frontendApi.uploadOutboundAttachment(session, new File([], 'empty.txt')),
    ).rejects.toMatchObject({ status: 400, code: 'empty_attachment' });
    const huge = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'video.mp4');
    const tooLarge = frontendApi.uploadOutboundAttachment(session, huge);
    await expect(tooLarge).rejects.toMatchObject({ status: 413, code: 'attachment_too_large' });
    await expect(tooLarge.catch((error: unknown) => errorMessage(error))).resolves.toBe(
      'That file is larger than 10 MB. Share it another way or attach a smaller file.',
    );
    const blocked = frontendApi.uploadOutboundAttachment(session, new File(['x'], 'Setup.EXE'));
    await expect(blocked).rejects.toMatchObject({ status: 415, code: 'blocked_file_type' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not replay an upload whose first attempt failed with a retryable status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      frontendApi.uploadOutboundAttachment(
        session,
        new File(['x'], 'eta.csv', { type: 'text/csv' }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deletes an upload, accepts the empty response and checks the session', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(session)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      frontendApi.deleteOutboundAttachment(session, attachment.id),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      `/v1/mailbox/outbound-attachments/${attachment.id}`,
      '/v1/me',
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('words the send refusals for the composer', () => {
    expect(errorMessage(new FrontendApiError(409, 'attachment_not_found'))).toBe(
      'An attached file is no longer available. Remove it and attach it again.',
    );
    expect(errorMessage(new FrontendApiError(413, 'attachments_too_large'))).toBe(
      'Attachments total more than 18 MB. Remove a file to send.',
    );
    expect(errorMessage(new FrontendApiError(503, 'outbound_attachments_unavailable'))).toBe(
      'Attachments are temporarily unavailable. Send without files or try again later.',
    );
  });
});

describe('copilot runs', () => {
  const runId = '00000000-0000-4000-8000-000000000031';
  const run = {
    id: runId,
    emailId: '00000000-0000-4000-8000-000000000011',
    gmailThreadId: 'abc123',
    instruction: 'draft a reply',
    status: 'running',
    proposal: null,
    toolCalls: [],
    model: 'gpt-6.1-sol',
    promptVersion: 'propose-reply-v1',
    usage: { inputTokens: 0, outputTokens: 0 },
    errorCode: null,
    createdAt: '2026-11-22T10:00:00.000Z',
    finishedAt: null,
  };

  it('starts a run as a POST that is never replayed, then checks the cookie still belongs to this session', async () => {
    let fetchMock = mockResponses(run, session);
    expect(
      await frontendApi.createAgentRun(session, {
        gmailThreadId: 'abc123',
        instruction: 'be brief',
      }),
    ).toEqual(run);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/v1/mailbox/agent/runs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ gmailThreadId: 'abc123', instruction: 'be brief' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v1/me', expect.anything());

    fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'oops' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      frontendApi.createAgentRun(session, { gmailThreadId: 'abc123' }),
    ).rejects.toMatchObject({ status: 503, code: 'oops' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mockResponses(run, { ...session, mailboxId: runId });
    await expect(
      frontendApi.createAgentRun(session, { gmailThreadId: 'abc123' }),
    ).rejects.toMatchObject({ code: 'session_changed' });
  });

  it('reads a run, refusing one whose id differs from the one asked for', async () => {
    const fetchMock = mockResponses(run, session);
    expect(await frontendApi.agentRun(session, runId)).toEqual(run);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/v1/mailbox/agent/runs/${runId}`,
      expect.not.objectContaining({ method: 'POST' }),
    );
    mockResponses({ ...run, id: run.emailId }, session);
    await expect(frontendApi.agentRun(session, runId)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('explains the copilot refusals in the operator words', async () => {
    for (const [code, status, text] of [
      ['thread_not_found', 404, 'This conversation has no incoming mail to reply to.'],
      [
        'agent_unavailable',
        503,
        'The copilot is not available right now. Write the reply by hand or try again later.',
      ],
      [
        'mailbox_not_connected',
        409,
        'Gmail is not connected for this mailbox. Connect it from the mailbox page, then send.',
      ],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(new Response(JSON.stringify({ error: code }), { status }))
          .mockResolvedValueOnce(new Response(JSON.stringify(session))),
      );
      const refusal = frontendApi.createAgentRun(session, { gmailThreadId: 'abc123' });
      await expect(refusal.catch((error: unknown) => errorMessage(error))).resolves.toBe(text);
    }
  });
});

describe('replies', () => {
  const emailId = '00000000-0000-4000-8000-000000000011';
  const sentMailId = '00000000-0000-4000-8000-000000000041';
  const sentMail = {
    id: sentMailId,
    kind: 'reply',
    status: 'sent',
    inReplyToEmailId: emailId,
    rfqId: null,
    vendorId: null,
    vendorContactId: null,
    gmailThreadId: 'abc123',
    rfcMessageId: '<x@example.com>',
    toRecipients: [{ name: 'Ravi', address: 'ravi@example.com' }],
    ccRecipients: [],
    subject: 'Re: Rates',
    bodyText: 'Dear Ravi',
    gmailMessageId: 'gm-9',
    errorCode: null,
    attachments: [],
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:01.000Z',
  };

  it('sends the reply as a POST that is never replayed, then checks the cookie still belongs to this session', async () => {
    let fetchMock = mockResponses(sentMail, session);
    expect(
      await frontendApi.sendReply(session, emailId, { sentMailId, text: 'Dear Ravi' }),
    ).toEqual(sentMail);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/v1/mailbox/emails/${emailId}/replies`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sentMailId, text: 'Dear Ravi' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v1/me', expect.anything());

    fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'oops' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      frontendApi.sendReply(session, emailId, { sentMailId, text: 'Dear Ravi' }),
    ).rejects.toMatchObject({ status: 503, code: 'oops' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mockResponses(sentMail, { ...session, mailboxId: emailId });
    await expect(
      frontendApi.sendReply(session, emailId, { sentMailId, text: 'Dear Ravi' }),
    ).rejects.toMatchObject({ code: 'session_changed' });
  });

  it('returns the failed or still-sending mail out of a 502 send_failed body instead of throwing', async () => {
    const failedMail = {
      ...sentMail,
      status: 'failed',
      gmailMessageId: null,
      errorCode: 'bad_request',
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'send_failed', sentMail: failedMail }), {
            status: 502,
          }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify(session))),
    );
    expect(
      await frontendApi.sendReply(session, emailId, { sentMailId, text: 'Dear Ravi' }),
    ).toEqual(failedMail);

    // A 502 without that body (a proxy, or another error) is still an error.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 })),
    );
    await expect(
      frontendApi.sendReply(session, emailId, { sentMailId, text: 'Dear Ravi' }),
    ).rejects.toMatchObject({ status: 502, code: 'request_failed' });
  });

  it('refuses a sent mail whose id is not the one minted for this send', async () => {
    mockResponses({ ...sentMail, id: emailId }, session);
    await expect(
      frontendApi.sendReply(session, emailId, { sentMailId, text: 'Dear Ravi' }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('explains the reply refusals in the operator words', async () => {
    for (const [code, status, text] of [
      ['not_inbound', 409, 'Only incoming mail can be answered here.'],
      ['no_sender', 409, 'This message has no sender address to reply to.'],
      ['sent_mail_id_taken', 409, 'This reply could not be started. Press Send again.'],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(new Response(JSON.stringify({ error: code }), { status }))
          .mockResolvedValueOnce(new Response(JSON.stringify(session))),
      );
      const refusal = frontendApi.sendReply(session, emailId, { sentMailId, text: 'Dear Ravi' });
      await expect(refusal.catch((error: unknown) => errorMessage(error))).resolves.toBe(text);
    }
  });
});
