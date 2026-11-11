import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrontendApiError, frontendApi } from './frontendApi.js';

const session = {
  mailboxId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
};
afterEach(() => vi.unstubAllGlobals());
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
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 401 }))
        .mockResolvedValueOnce(new Response('proxy failed', { status: 502 })),
    );
    expect(await frontendApi.session()).toBeNull();
    await expect(frontendApi.session()).rejects.toMatchObject({ status: 502 });
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
    await expect(frontendApi.emails(session, undefined, undefined)).rejects.toThrow();
    await expect(frontendApi.connect()).rejects.toThrow();
  });
  it('encodes cursor/filter and passes AbortSignal without any mailbox identifier', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...session, emails: [], nextCursor: null })),
      );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await frontendApi.emails(session, 'sent', 'a+b/c', controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/mailbox/emails?limit=30&label=sent&cursor=a%2Bb%2Fc',
      expect.objectContaining({ signal: controller.signal }),
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
      await expect(frontendApi.emails(session, undefined, undefined)).rejects.toMatchObject({
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
    const response = await frontendApi.emails(session, 'inbox', undefined);
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
      expect(options).toMatchObject({
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
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
});
