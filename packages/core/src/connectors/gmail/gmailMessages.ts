import { OAuth2Client } from 'google-auth-library';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';
import { decodeGmailRawMessage } from '../../utils/mime/parseRawEmail.js';
import type { GoogleOAuthClientCredentials } from './gmailOAuth.js';
import { toGmailApiError } from './gmailApiError.js';

/** One message as Gmail stores it: the RFC 822 bytes plus the Gmail-side facts the parser cannot know. */
export interface GmailRawMessage {
  raw: Uint8Array;
  threadId: string;
  /** Gmail's labels at fetch time (INBOX, SENT, UNREAD, user labels...). */
  labelIds: string[];
  /** When Gmail received or sent the message; the fallback for a missing Date header. */
  internalDate: Date;
  /** Gmail's short plain-text preview of the body. */
  snippet: string;
}

export interface GmailMessages {
  /**
   * messages.get with format=raw. Throws GmailApiError('not_found') when the message was deleted
   * between the push and the fetch, 'invalid_grant' when the refresh token is dead.
   */
  getRawMessage(input: {
    credentials: GoogleOAuthClientCredentials;
    refreshToken: string;
    gmailMessageId: string;
  }): Promise<GmailRawMessage>;
}

interface MessageGetResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  /** Epoch milliseconds as a decimal string. */
  internalDate: string;
  /** RFC 822 bytes, base64url. */
  raw: string;
}

const GMAIL_MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

/** Plain REST via OAuth2Client.request, like gmailHistory and gmailWatch. */
export function createGoogleGmailMessages(): GmailMessages {
  return {
    getRawMessage({ credentials, refreshToken, gmailMessageId }) {
      return runInsideSpan('gmail.messages.get', async (span) => {
        const oauthClient = new OAuth2Client({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
        });
        oauthClient.setCredentials({ refresh_token: refreshToken });

        let message: MessageGetResponse;
        try {
          const response = await oauthClient.request<MessageGetResponse>({
            url: `${GMAIL_MESSAGES_URL}/${encodeURIComponent(gmailMessageId)}`,
            method: 'GET',
            params: { format: 'raw' },
          });
          message = response.data;
        } catch (error) {
          throw toGmailApiError(error);
        }
        const raw = decodeGmailRawMessage(message.raw);
        span.setAttributes({ 'gmail.message.size_bytes': raw.byteLength });
        return {
          raw,
          threadId: message.threadId,
          labelIds: message.labelIds ?? [],
          internalDate: new Date(Number(message.internalDate)),
          snippet: message.snippet ?? '',
        };
      });
    },
  };
}
