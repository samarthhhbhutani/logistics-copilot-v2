import {
  agentRunResponseSchema,
  attachmentDownloadUrlResponseSchema,
  currentClassificationSchema,
  draftRfqMailsResponseSchema,
  emailDetailSchema,
  getRfqBySourceEmailResponseSchema,
  getRfqResponseSchema,
  listAttachmentsResponseSchema,
  listRfqsResponseSchema,
  listSignatureImagesResponseSchema,
  listVendorsResponseSchema,
  threadResponseSchema,
  gmailConnectResponseSchema,
  listEmailsResponseSchema,
  mailboxResponseSchema,
  rfqSuggestionResponseSchema,
  sendRfqResponseSchema,
  sessionResponseSchema,
  signatureImageResponseSchema,
  SIGNATURE_IMAGE_CONTENT_TYPES,
  SIGNATURE_IMAGE_MAX_BYTES,
  SIGNATURE_IMAGES_MAX_PER_MAILBOX,
} from '@lc/contract';
import type {
  ClassificationLabel,
  CreateAgentRunRequest,
  DraftRfqMailsBody,
  GmailLabel,
  SendRfqBody,
  SessionResponse,
} from '@lc/contract';
import { readNetworkResponse, requestWithRetry } from './frontendRequest.js';
import type { RequestRetryOptions } from './frontendRequest.js';

/** What the mail list is narrowed to: a Gmail folder, a current classification, both or neither. */
export interface MailListFilter {
  label?: GmailLabel;
  classification?: ClassificationLabel;
}

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
        // JSON unless the caller says otherwise (a raw image upload carries its own type).
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
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

/** Customer mails per page on the vendor quotes page; a desk's week fits on one. */
export const RFQ_PAGE_SIZE = 20;

/** These POSTs only set or clear the session cookie or return an OAuth URL, so a replay is harmless. */
const REPLAY_SAFE_POST: RequestRetryOptions = { replaySafe: true };
/** The suggestion and drafts POSTs store nothing: a replay costs one more model call and nothing else. */
const REPLAY_SAFE_LLM_POST: RequestRetryOptions = { replaySafe: true };
/** Storing the same signature twice leaves the mailbox exactly as the first write did. */
const REPLAY_SAFE_PATCH: RequestRetryOptions = { replaySafe: true };

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
  options: RequestInit = {},
  retryOptions?: RequestRetryOptions,
): Promise<ResponseBody> {
  try {
    return await requestJson(path, schema, { ...options, signal }, retryOptions);
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
  /**
   * Stores the HTML signature (null clears it) and returns the mailbox as the server now has it:
   * the HTML comes back sanitised, so the editor should reload from the response, not keep its own.
   */
  async updateSignature(
    session: SessionResponse,
    signatureHtml: string | null,
    signal?: AbortSignal,
  ) {
    return requireMatchingSession(
      await requestJson(
        '/mailbox/signature',
        mailboxResponseSchema,
        { method: 'PATCH', body: JSON.stringify({ signatureHtml }), signal },
        REPLAY_SAFE_PATCH,
      ),
      session,
    );
  },
  /** The mailbox's uploaded signature images, oldest first, each with a short-lived preview link. */
  async signatureImages(session: SessionResponse, signal?: AbortSignal) {
    const body = await requestJson('/mailbox/signature/images', listSignatureImagesResponseSchema, {
      signal,
    });
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return body;
  },
  /**
   * Uploads one image as raw bytes. Type and size are checked here first with the server's own
   * error codes, so an oversized photo never leaves the browser. Never replayed: a second copy
   * would count against the per-mailbox limit.
   */
  async uploadSignatureImage(session: SessionResponse, file: File, signal?: AbortSignal) {
    if (!isSignatureImageContentType(file.type)) {
      throw new FrontendApiError(415, 'unsupported_image_type');
    }
    if (file.size > SIGNATURE_IMAGE_MAX_BYTES) throw new FrontendApiError(413, 'image_too_large');
    const fileName = file.name.trim();
    const path = fileName
      ? `/mailbox/signature/images?${new URLSearchParams({ fileName })}`
      : '/mailbox/signature/images';
    const image = await requestJson(path, signatureImageResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
      signal,
    });
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return image;
  },
  /** Removes an uploaded image; the server refuses (signature_image_in_use) while the signature still shows it. */
  async deleteSignatureImage(session: SessionResponse, imageId: string, signal?: AbortSignal) {
    await requestJson(
      `/mailbox/signature/images/${encodeURIComponent(imageId)}`,
      { parse: () => undefined },
      { method: 'DELETE', signal },
    );
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
  },
  async emails(
    session: SessionResponse,
    filter: MailListFilter,
    cursor: string | undefined,
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ limit: '30' });
    if (filter.label) query.set('label', filter.label);
    if (filter.classification) query.set('classification', filter.classification);
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
  /** What the model read out of the customer mail, as prefill for the RFQ form. Nothing is stored. */
  async rfqSuggestion(session: SessionResponse, emailId: string, signal?: AbortSignal) {
    const suggestion = await requestMailJson(
      session,
      `/mailbox/emails/${encodeURIComponent(emailId)}/rfq-suggestion`,
      rfqSuggestionResponseSchema,
      signal,
      { method: 'POST' },
      REPLAY_SAFE_LLM_POST,
    );
    // The suggestion carries no mailbox identity; make sure the cookie still belongs to this session.
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return suggestion;
  },
  /** Every vendor of the desk with its contacts, archived included; the picker filters. */
  async vendors(session: SessionResponse, signal?: AbortSignal) {
    const body = await requestJson('/mailbox/vendors', listVendorsResponseSchema, { signal });
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return body;
  },
  /** One draft mail per vendor category for the corrected details. Nothing is stored or sent. */
  async rfqDrafts(session: SessionResponse, body: DraftRfqMailsBody, signal?: AbortSignal) {
    const drafts = await requestMailJson(
      session,
      '/mailbox/rfqs/drafts',
      draftRfqMailsResponseSchema,
      signal,
      { method: 'POST', body: JSON.stringify(body) },
      REPLAY_SAFE_LLM_POST,
    );
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return drafts;
  },
  /**
   * Sends one mail per ticked contact. `rfqId` is minted by the caller (crypto.randomUUID) and is the
   * idempotency key: the same PUT again is the retry, sending only what is still pending or failed.
   * Never replayed by the transport: a send that did not answer is retried by the operator.
   */
  async sendRfq(session: SessionResponse, rfqId: string, body: SendRfqBody, signal?: AbortSignal) {
    const result = await requestMailJson(
      session,
      `/mailbox/rfqs/${encodeURIComponent(rfqId)}/send`,
      sendRfqResponseSchema,
      signal,
      { method: 'PUT', body: JSON.stringify(body) },
    );
    if (result.rfq.id !== rfqId) throw new FrontendApiError(502, 'invalid_response');
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return result;
  },
  /** The RFQ and its mails as they stand now; polled while a mail is still `sending`. */
  async rfq(session: SessionResponse, rfqId: string, signal?: AbortSignal) {
    const result = await requestMailJson(
      session,
      `/mailbox/rfqs/${encodeURIComponent(rfqId)}`,
      getRfqResponseSchema,
      signal,
    );
    if (result.rfq.id !== rfqId) throw new FrontendApiError(502, 'invalid_response');
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return result;
  },
  /**
   * Asks the copilot for a reply to a thread; answers at once with the run in `running`, to be
   * polled with agentRun. Never replayed by the transport: a replay would start a second run.
   */
  async createAgentRun(
    session: SessionResponse,
    body: CreateAgentRunRequest,
    signal?: AbortSignal,
  ) {
    const run = await requestMailJson(
      session,
      '/mailbox/agent/runs',
      agentRunResponseSchema,
      signal,
      { method: 'POST', body: JSON.stringify(body) },
    );
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return run;
  },
  /** The run as it stands now; polled while its status is `running`. */
  async agentRun(session: SessionResponse, runId: string, signal?: AbortSignal) {
    const run = await requestMailJson(
      session,
      `/mailbox/agent/runs/${encodeURIComponent(runId)}`,
      agentRunResponseSchema,
      signal,
    );
    if (run.id !== runId) throw new FrontendApiError(502, 'invalid_response');
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return run;
  },
  /** A page of the mailbox's RFQs newest first, grouped by customer mail; `cursor` from the previous page's nextCursor. */
  async rfqs(session: SessionResponse, cursor: string | undefined, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: String(RFQ_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const result = await requestJson(`/mailbox/rfqs?${query}`, listRfqsResponseSchema, { signal });
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return result;
  },
  /**
   * The newest RFQ sent from a customer mail, or null when none was: how the panel finds its RFQ
   * after a reload. The scoped 404 goes through the identity check first, so only a genuine
   * "no RFQ for this mail" becomes null; another tab's cookie is still a session_changed.
   */
  async rfqBySourceEmail(session: SessionResponse, emailId: string, signal?: AbortSignal) {
    let result;
    try {
      result = await requestMailJson(
        session,
        `/mailbox/rfqs/bySourceEmail/${encodeURIComponent(emailId)}`,
        getRfqBySourceEmailResponseSchema,
        signal,
      );
    } catch (error) {
      if (error instanceof FrontendApiError && error.status === 404) return null;
      throw error;
    }
    if (result.rfq.sourceEmailId !== emailId) throw new FrontendApiError(502, 'invalid_response');
    requireMatchingSession(await requestJson('/me', sessionResponseSchema, { signal }), session);
    return result;
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

function isSignatureImageContentType(
  contentType: string,
): contentType is (typeof SIGNATURE_IMAGE_CONTENT_TYPES)[number] {
  return (SIGNATURE_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType);
}

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
    if (error.code === 'thread_not_found')
      return 'This conversation has no incoming mail to reply to.';
    if (error.status === 404) return 'This message is no longer available in your mailbox.';
    if (error.code === 'google_client_not_configured' || error.code === 'pubsub_not_configured') {
      return 'Gmail setup is not complete for your workspace. Please contact your administrator.';
    }
    if (error.code === 'invalid_cursor')
      return 'This page link is no longer valid. Return to the newest mail.';
    if (error.code === 'suggestion_unavailable')
      return 'Shipment details could not be suggested right now. Fill them in by hand or try again.';
    if (error.code === 'suggestion_failed')
      return 'We could not read shipment details from this message. Fill them in by hand.';
    if (error.code === 'drafts_unavailable')
      return 'Vendor mails could not be drafted right now. Try again in a moment.';
    if (error.code === 'drafts_failed')
      return 'We could not draft the vendor mails from these details. Adjust them and try again.';
    if (error.code === 'vendor_not_found' || error.code === 'contact_not_found')
      return 'A chosen vendor contact is no longer available. Reload the vendor list and choose again.';
    if (error.code === 'missing_mail_text')
      return 'A ticked vendor has no mail text for its category. Write the vendor mails first.';
    if (error.code === 'mailbox_not_connected')
      return 'Gmail is not connected for this mailbox. Connect it from the mailbox page, then send.';
    if (error.code === 'rfq_id_taken')
      return 'This request was already started for another message. Close the panel and start again.';
    if (error.code === 'signature_too_long')
      return 'The signature is too long. Shorten it and save again.';
    if (error.code === 'unsupported_image_type')
      return 'Only PNG, JPEG and GIF images can be used in a signature.';
    if (error.code === 'image_too_large')
      return `That image is larger than ${SIGNATURE_IMAGE_MAX_BYTES / 1024} KB. Use a smaller logo.`;
    if (error.code === 'signature_image_limit_reached')
      return `A signature can hold at most ${SIGNATURE_IMAGES_MAX_PER_MAILBOX} images. Remove one before adding another.`;
    if (error.code === 'signature_images_unavailable')
      return 'Signature images are temporarily unavailable. Please try again later.';
    if (error.code === 'signature_image_in_use')
      return 'This image is still in your signature. Remove it from the signature first.';
    if (error.code === 'agent_unavailable')
      return 'The copilot is not available right now. Write the reply by hand or try again later.';
  }
  return 'We could not reach your workspace. Check your connection and try again.';
}
