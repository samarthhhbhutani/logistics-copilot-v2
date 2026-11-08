import { OAuth2Client } from 'google-auth-library';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';
import type { GoogleOAuthClientCredentials } from './gmailOAuth.js';

/** Labels a watch reports on: inbound mail and what the operator sends, nothing else (drafts, spam). */
export const GMAIL_WATCH_LABEL_IDS = ['INBOX', 'SENT'];

/** What users.watch returns: where the mailbox stands now and when Gmail stops publishing. */
export interface GmailWatchResult {
  /** The mailbox's current history id: the cursor the first history.list starts from. */
  historyId: bigint;
  /** Gmail watches live at most 7 days; the renewer re-watches before this passes. */
  expiresAt: Date;
}

export interface GmailWatch {
  startWatch(input: {
    credentials: GoogleOAuthClientCredentials;
    refreshToken: string;
    topicName: string;
  }): Promise<GmailWatchResult>;
  stopWatch(input: {
    credentials: GoogleOAuthClientCredentials;
    refreshToken: string;
  }): Promise<void>;
}

export type GmailApiErrorCode =
  /** The refresh token is dead (revoked, password changed, 7-day test expiry): the mailbox needs a reconnect. */
  | 'invalid_grant'
  /** users.watch 400: the topic is the only argument a tenant supplies, so it is missing or in another project (docs/clientOnboarding, part C). */
  | 'topic_rejected'
  /** users.watch 403 forbidden: gmail-api-push@system.gserviceaccount.com lacks Publisher on the topic (part C, step 2). */
  | 'topic_not_authorized'
  /** 403 accessNotConfigured: the tenant never enabled the Gmail API in their project (part B). */
  | 'gmail_api_disabled'
  | 'request_failed';

export class GmailApiError extends Error {
  constructor(
    readonly code: GmailApiErrorCode,
    readonly httpStatus: number | undefined,
    detail?: string,
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

/**
 * Classifies a failed Google call from structured fields only (HTTP status, token `error`,
 * Gmail `errors[].reason`), never from message text Google may reword. The message is kept as
 * detail for the log.
 */
export function toGmailApiError(error: unknown): GmailApiError {
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

  if (httpStatus === 400) return new GmailApiError('topic_rejected', httpStatus, detail);
  if (httpStatus === 403 && reason === 'accessNotConfigured') {
    return new GmailApiError('gmail_api_disabled', httpStatus, detail);
  }
  if (httpStatus === 403) return new GmailApiError('topic_not_authorized', httpStatus, detail);
  return new GmailApiError('request_failed', httpStatus, detail);
}

const GMAIL_USERS_ME_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * users.watch and users.stop over a tenant's OAuth client. google-auth-library swaps the refresh
 * token for an access token on the first request and again when it expires; a dead refresh token
 * surfaces as GmailApiError('invalid_grant'). Plain REST via OAuth2Client.request: the two
 * endpoints are not worth the googleapis dependency.
 */
export function createGoogleGmailWatch(): GmailWatch {
  function createAuthorizedClient(
    credentials: GoogleOAuthClientCredentials,
    refreshToken: string,
  ): OAuth2Client {
    const oauthClient = new OAuth2Client({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    oauthClient.setCredentials({ refresh_token: refreshToken });
    return oauthClient;
  }

  return {
    startWatch({ credentials, refreshToken, topicName }) {
      return runInsideSpan('gmail.users.watch', async () => {
        try {
          const response = await createAuthorizedClient(credentials, refreshToken).request<{
            historyId: string;
            expiration: string;
          }>({
            url: `${GMAIL_USERS_ME_URL}/watch`,
            method: 'POST',
            data: {
              topicName,
              labelIds: GMAIL_WATCH_LABEL_IDS,
              labelFilterBehavior: 'INCLUDE',
            },
          });
          return {
            historyId: BigInt(response.data.historyId),
            // Gmail returns the expiry as epoch milliseconds in a string.
            expiresAt: new Date(Number(response.data.expiration)),
          };
        } catch (error) {
          throw toGmailApiError(error);
        }
      });
    },

    stopWatch({ credentials, refreshToken }) {
      return runInsideSpan('gmail.users.stop', async () => {
        try {
          await createAuthorizedClient(credentials, refreshToken).request({
            url: `${GMAIL_USERS_ME_URL}/stop`,
            method: 'POST',
          });
        } catch (error) {
          throw toGmailApiError(error);
        }
      });
    },
  };
}
