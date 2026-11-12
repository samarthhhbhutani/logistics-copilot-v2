import {
  attachmentDownloadUrlResponseSchema,
  currentClassificationSchema,
  emailDetailSchema,
  listAttachmentsResponseSchema,
  threadResponseSchema,
  gmailConnectResponseSchema,
  listEmailsResponseSchema,
  mailboxResponseSchema,
  sessionResponseSchema,
} from '@lc/contract';
import type { ClassificationLabel, GmailLabel, SessionResponse } from '@lc/contract';
import { readNetworkResponse, requestWithRetry } from './frontendRequest.js';
import type { RequestRetryOptions } from './frontendRequest.js';

export class FrontendApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'FrontendApiError';
  }
}

/** The append may have committed even though its response or final identity check was lost. */
export class ClassificationOutcomeUnknownError extends Error {
  constructor() {
    super('Classification outcome unknown');
    this.name = 'ClassificationOutcomeUnknownError';
  }
}

/** Never persist session tokens or mail in browser storage. The httpOnly cookie is sent by fetch. */
async function requestJson<ResponseBody>(
  path: string,
  schema: { parse(value: unknown): ResponseBody },
  options: RequestInit = {},
  retryOptions?: RequestRetryOptions,
): Promise<ResponseBody> {
  const body = await requestWithRetry(
    `/v1${path}`,
    {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...options.headers,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    },
    readJsonBody,
    undefined,
    retryOptions,
  );
  // Parsed outside the retry transport so a schema failure is never replayed.
  return schema.parse(body);
}

async function readJsonBody(response: Response): Promise<unknown> {
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
    throw new FrontendApiError(response.status, code);
  }
  return response.status === 204 ? undefined : await readNetworkResponse(response.json());
}

/** These POSTs only set or clear the session cookie or return an OAuth URL, so a replay is harmless. */
const REPLAY_SAFE_POST: RequestRetryOptions = { replaySafe: true };

function requireMatchingSession<ResponseBody extends SessionResponse>(
  body: ResponseBody,
  session: SessionResponse,
): ResponseBody {
  if (body.mailboxId !== session.mailboxId || body.tenantId !== session.tenantId) {
    // A different tab can replace the shared cookie between any two requests.
    // Reject before React Query can cache another account's response under this session.
    throw new FrontendApiError(401, 'session_changed');
  }
  return body;
}

/** A scoped 404 may mean another tab replaced the cookie, rather than a missing message. */
async function requestMailJson<ResponseBody>(
  session: SessionResponse,
  path: string,
  schema: { parse(value: unknown): ResponseBody },
  signal?: AbortSignal,
): Promise<ResponseBody> {
  try {
    return await requestJson(path, schema, { signal });
  } catch (error) {
    if (error instanceof FrontendApiError && error.status === 404) {
      requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    }
    throw error;
  }
}

export const frontendApi = {
  async session(signal?: AbortSignal) {
    try {
      return await requestJson('/me', sessionResponseSchema, { signal });
    } catch (error) {
      if (isUnauthenticated(error)) return null;
      throw error;
    }
  },
  login(email: string, password: string, signal?: AbortSignal) {
    return requestJson(
      '/auth/login',
      sessionResponseSchema,
      { method: 'POST', body: JSON.stringify({ email, password }), signal },
      REPLAY_SAFE_POST,
    );
  },
  logout(signal?: AbortSignal) {
    return requestJson(
      '/auth/logout',
      { parse: () => undefined },
      { method: 'POST', signal },
      REPLAY_SAFE_POST,
    );
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
  async thread(session: SessionResponse, emailId: string, signal?: AbortSignal) {
    // Anchor the thread to a globally unique email id, not just Gmail's thread id, which can
    // appear in multiple mailboxes. A cross-tab cookie switch cannot substitute another thread.
    const email = await requestMailJson(
      session,
      `/mailbox/emails/${encodeURIComponent(emailId)}`,
      emailDetailSchema,
      signal,
    );
    if (email.id !== emailId) throw new FrontendApiError(502, 'invalid_response');
    const thread = await requestMailJson(
      session,
      `/mailbox/threads/${encodeURIComponent(email.gmailThreadId)}`,
      threadResponseSchema,
      signal,
    );
    if (
      thread.gmailThreadId !== email.gmailThreadId ||
      !thread.emails.some((message) => message.id === emailId) ||
      thread.emails.some((message) => message.gmailThreadId !== email.gmailThreadId)
    ) {
      throw new FrontendApiError(401, 'session_changed');
    }
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return thread;
  },
  async correctClassification(
    session: SessionResponse,
    emailId: string,
    label: ClassificationLabel,
    signal?: AbortSignal,
  ) {
    // A shared cookie can change in another tab. Check it before the irreversible append, then
    // again before accepting a response that carries no mailbox identity. Never replay this POST:
    // every attempt writes a new classification row, including an unchanged-label confirmation.
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    let classification;
    try {
      classification = await requestJson(
        `/mailbox/emails/${encodeURIComponent(emailId)}/classifications`,
        currentClassificationSchema,
        { method: 'POST', body: JSON.stringify({ label }), signal },
      );
    } catch (error) {
      if (error instanceof FrontendApiError && error.status === 404) {
        try {
          requireMatchingSession(
            await requestJson('/me', sessionResponseSchema, { signal }),
            session,
          );
        } catch (sessionError) {
          if (signal?.aborted) throw signal.reason;
          if (isUnauthenticated(sessionError)) throw sessionError;
          // A failed identity read cannot change the POST's definite not-found result.
        }
      }
      if (error instanceof FrontendApiError && [400, 401, 404, 409].includes(error.status))
        throw error;
      if (signal?.aborted) throw signal.reason;
      throw new ClassificationOutcomeUnknownError();
    }
    try {
      requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    } catch (error) {
      if (isUnauthenticated(error)) throw error;
      if (signal?.aborted) throw signal.reason;
      throw new ClassificationOutcomeUnknownError();
    }
    signal?.throwIfAborted();
    if (
      classification.label !== label ||
      classification.source !== 'user' ||
      classification.confidence !== null
    ) {
      // A response that does not reflect this append cannot be shown as a successful correction.
      // A write may still have happened, so the UI requires a fresh read instead of replaying it.
      throw new ClassificationOutcomeUnknownError();
    }
    return classification;
  },
  async attachments(session: SessionResponse, emailId: string, signal?: AbortSignal) {
    const body = await requestMailJson(
      session,
      `/mailbox/emails/${encodeURIComponent(emailId)}/attachments`,
      listAttachmentsResponseSchema,
      signal,
    );
    if (body.emailId !== emailId) throw new FrontendApiError(502, 'invalid_response');
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return body;
  },
  async attachmentDownload(
    session: SessionResponse,
    emailId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ) {
    const body = await requestMailJson(
      session,
      `/mailbox/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}/download-url`,
      attachmentDownloadUrlResponseSchema,
      signal,
    );
    const target = new URL(body.url);
    if (target.protocol !== 'https:' || target.username || target.password) {
      throw new FrontendApiError(502, 'invalid_download_url');
    }
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return body;
  },
  connect(signal?: AbortSignal) {
    return requestJson(
      '/mailbox/gmail/connect',
      gmailConnectResponseSchema,
      { method: 'POST', signal },
      REPLAY_SAFE_POST,
    );
  },
};

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof FrontendApiError && error.status === 401;
}

export function errorMessage(error: unknown): string {
  if (error instanceof FrontendApiError) {
    if (error.code === 'invalid_credentials')
      return 'That email and password do not match. Please try again.';
    if (error.status === 401) return 'Your session has expired. Sign in again to continue.';
    if (error.code === 'attachments_unavailable')
      return 'Downloads are temporarily unavailable. Please try again later.';
    if (error.status === 429) return 'Too many requests. Please try again in a moment.';
    if (error.code === 'mailbox_not_found')
      return 'Your mailbox is unavailable. Please contact your workspace administrator.';
    if (error.status === 404) return 'This message is no longer available in your mailbox.';
    if (error.code === 'google_client_not_configured' || error.code === 'pubsub_not_configured') {
      return 'Gmail setup is not complete for your workspace. Please contact your administrator.';
    }
    if (error.code === 'invalid_cursor')
      return 'This page link is no longer valid. Return to the newest mail.';
  }
  return 'We could not reach your workspace. Check your connection and try again.';
}
