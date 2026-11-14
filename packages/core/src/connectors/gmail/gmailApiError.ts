export type GmailApiErrorCode =
  /** The refresh token is dead (revoked, password changed, 7-day test expiry): the mailbox needs a reconnect. */
  | 'invalid_grant'
  /** 400 from a Gmail call. Each call decides what its 400 means (users.watch remaps it to topic_rejected). */
  | 'bad_request'
  /** 403 other than accessNotConfigured. */
  | 'forbidden'
  /** 403 accessNotConfigured: the tenant never enabled the Gmail API in their project (docs/clientOnboarding, part B). */
  | 'gmail_api_disabled'
  /** 404: for history.list, the cursor is older than Gmail keeps history for. */
  | 'not_found'
  /** 429 or 403 rateLimitExceeded / userRateLimitExceeded. */
  | 'rate_limited'
  /** users.watch 400: the topic is the only argument a tenant supplies, so it is missing or in another project (part C). */
  | 'topic_rejected'
  /** users.watch 403: gmail-api-push@system.gserviceaccount.com lacks Publisher on the topic (part C, step 2). */
  | 'topic_not_authorized'
  | 'request_failed';

export class GmailApiError extends Error {
  constructor(
    readonly code: GmailApiErrorCode,
    readonly httpStatus: number | undefined,
    /** Google's own message, for the log; never used for classification. */
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GmailApiError';
  }
}

/** Token endpoint failure: google-auth-library hit it while refreshing the access token. */
interface GoogleTokenErrorBody {
  error: string;
  error_description?: string;
}

/** Gmail API failure. `reason` is the only field finer than the HTTP status. */
interface GmailApiErrorBody {
  error: { message?: string; errors?: { reason?: string }[] };
}

function isTokenErrorBody(data: unknown): data is GoogleTokenErrorBody {
  return typeof (data as GoogleTokenErrorBody | undefined)?.error === 'string';
}

function isGmailApiErrorBody(data: unknown): data is GmailApiErrorBody {
  const body = data as GmailApiErrorBody | undefined;
  return typeof body?.error === 'object' && body.error !== null;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/**
 * Classifies a failed Google call from structured fields only (HTTP status, token `error`,
 * Gmail `errors[].reason`), never from message text Google may reword. The message is kept as
 * detail for the log.
 */
export function toGmailApiError(error: unknown): GmailApiError {
  if (error instanceof GmailApiError) return error;
  const response = (error as { response?: { status?: number; data?: unknown } }).response;
  const httpStatus = response?.status;
  const data = response?.data;

  if (isTokenErrorBody(data)) {
    const detail = data.error_description ?? data.error;
    return new GmailApiError(
      data.error === 'invalid_grant' ? 'invalid_grant' : 'request_failed',
      httpStatus,
      detail,
    );
  }

  const detail = isGmailApiErrorBody(data)
    ? data.error.message
    : error instanceof Error
      ? error.message
      : String(error);
  const reason = isGmailApiErrorBody(data) ? data.error.errors?.[0]?.reason : undefined;

  if (reason && RATE_LIMIT_REASONS.has(reason)) {
    return new GmailApiError('rate_limited', httpStatus, detail);
  }
  switch (httpStatus) {
    case 400:
      return new GmailApiError('bad_request', httpStatus, detail);
    case 403:
      return new GmailApiError(
        reason === 'accessNotConfigured' ? 'gmail_api_disabled' : 'forbidden',
        httpStatus,
        detail,
      );
    case 404:
      return new GmailApiError('not_found', httpStatus, detail);
    case 429:
      return new GmailApiError('rate_limited', httpStatus, detail);
    default:
      return new GmailApiError('request_failed', httpStatus, detail);
  }
}

/**
 * Gmail answered with a 4xx: the request was refused, so whatever it asked for certainly did not
 * happen. A 5xx or no response at all (timeout, reset) leaves the outcome unknown.
 */
export function isDefinitiveGmailRejection(error: unknown): error is GmailApiError {
  return (
    error instanceof GmailApiError &&
    error.httpStatus !== undefined &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500
  );
}
