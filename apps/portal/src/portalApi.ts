import {
  gmailConnectResponseSchema,
  listEmailsResponseSchema,
  mailboxResponseSchema,
  sessionResponseSchema,
} from '@lc/contract';
import type { GmailLabel, SessionResponse } from '@lc/contract';

export class PortalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'PortalApiError';
  }
}

/** Never persist session tokens or mail in browser storage. The httpOnly cookie is sent by fetch. */
async function requestJson<ResponseBody>(
  path: string,
  schema: { parse(value: unknown): ResponseBody },
  options: RequestInit = {},
): Promise<ResponseBody> {
  const response = await fetch(`/v1${path}`, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...options.headers,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!response.ok) {
    let code = 'request_failed';
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        code = body.error;
      }
    } catch {
      /* A proxy outage can return HTML rather than JSON. */
    }
    throw new PortalApiError(response.status, code);
  }
  const body: unknown = response.status === 204 ? undefined : await response.json();
  return schema.parse(body);
}

function requireMatchingSession<ResponseBody extends SessionResponse>(
  body: ResponseBody,
  session: SessionResponse,
): ResponseBody {
  if (body.mailboxId !== session.mailboxId || body.tenantId !== session.tenantId) {
    // A different tab can replace the shared cookie between any two requests.
    // Reject before React Query can cache another account's response under this session.
    throw new PortalApiError(401, 'session_changed');
  }
  return body;
}

export const portalApi = {
  async session(signal?: AbortSignal) {
    try {
      return await requestJson('/me', sessionResponseSchema, { signal });
    } catch (error) {
      if (isUnauthenticated(error)) return null;
      throw error;
    }
  },
  login(email: string, password: string) {
    return requestJson('/auth/login', sessionResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },
  logout() {
    return requestJson('/auth/logout', { parse: () => undefined }, { method: 'POST' });
  },
  async mailbox(session: SessionResponse, signal?: AbortSignal) {
    return requireMatchingSession(
      await requestJson('/mailbox', mailboxResponseSchema, { signal }),
      session,
    );
  },
  async emails(
    session: SessionResponse,
    label: GmailLabel | undefined,
    cursor: string | undefined,
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ limit: '30' });
    if (label) query.set('label', label);
    if (cursor) query.set('cursor', cursor);
    return requireMatchingSession(
      await requestJson(`/mailbox/emails?${query}`, listEmailsResponseSchema, { signal }),
      session,
    );
  },
  connect() {
    return requestJson('/mailbox/gmail/connect', gmailConnectResponseSchema, { method: 'POST' });
  },
};

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof PortalApiError && error.status === 401;
}

export function errorMessage(error: unknown): string {
  if (error instanceof PortalApiError) {
    if (error.code === 'invalid_credentials')
      return 'That email and password do not match. Please try again.';
    if (error.status === 401) return 'Your session has expired. Sign in again to continue.';
    if (error.status === 429) return 'Too many requests. Please try again in a moment.';
    if (error.code === 'mailbox_not_found')
      return 'Your mailbox is unavailable. Please contact your workspace administrator.';
    if (error.code === 'google_client_not_configured' || error.code === 'pubsub_not_configured') {
      return 'Gmail setup is not complete for your workspace. Please contact your administrator.';
    }
    if (error.code === 'invalid_cursor')
      return 'This page link is no longer valid. Return to the newest mail.';
  }
  return 'We could not reach your workspace. Check your connection and try again.';
}
