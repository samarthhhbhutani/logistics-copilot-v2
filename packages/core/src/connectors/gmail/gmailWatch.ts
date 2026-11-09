import { OAuth2Client } from 'google-auth-library';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';
import type { GoogleOAuthClientCredentials } from './gmailOAuth.js';
import { GmailApiError, toGmailApiError } from './gmailApiError.js';

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
          throw toWatchError(toGmailApiError(error));
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

/**
 * users.watch is the one call where the tenant supplies an argument (the topic), so its 400 and
 * 403 name the onboarding mistake instead of the bare status.
 */
export function toWatchError(error: GmailApiError): GmailApiError {
  switch (error.code) {
    case 'bad_request':
      return new GmailApiError('topic_rejected', error.httpStatus, error.detail);
    case 'forbidden':
      return new GmailApiError('topic_not_authorized', error.httpStatus, error.detail);
    default:
      return error;
  }
}
