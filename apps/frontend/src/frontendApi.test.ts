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
