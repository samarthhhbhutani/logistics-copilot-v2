import { OAuth2Client } from 'google-auth-library';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';
import type { GoogleOAuthClientCredentials } from './gmailOAuth.js';
import { toGmailApiError } from './gmailApiError.js';
import { GMAIL_WATCH_LABEL_IDS } from './gmailWatch.js';

/** Everything history.list reported since the cursor, and the cursor to store next. */
export interface GmailHistoryPage {
  /** Ids of messages added with an INBOX or SENT label, deduplicated, in history order. */
  messageIds: string[];
  /** The mailbox's history id at the end of the listing: the next startHistoryId. */
  historyId: bigint;
}

export interface GmailHistory {
  /**
   * Walks history.list from startHistoryId (exclusive) through every page. Throws
   * GmailApiError('not_found') when the cursor is older than Gmail keeps history for.
   */
  listMessagesAddedSince(input: {
    credentials: GoogleOAuthClientCredentials;
    refreshToken: string;
    startHistoryId: bigint;
  }): Promise<GmailHistoryPage>;
}

interface HistoryListResponse {
  history?: {
    messagesAdded?: { message: { id: string; labelIds?: string[] } }[];
  }[];
  nextPageToken?: string;
  historyId: string;
}

const GMAIL_HISTORY_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/history';

/**
 * Plain REST via OAuth2Client.request, like gmailWatch. labelId would filter the request to one
 * label, so the two watched labels are filtered here from each message's labelIds instead.
 */
export function createGoogleGmailHistory(): GmailHistory {
  return {
    listMessagesAddedSince({ credentials, refreshToken, startHistoryId }) {
      return runInsideSpan('gmail.history.list', async (span) => {
        const oauthClient = new OAuth2Client({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
        });
        oauthClient.setCredentials({ refresh_token: refreshToken });

        const messageIds = new Set<string>();
        let historyId = startHistoryId;
        let pageToken: string | undefined;
        let pages = 0;
        try {
          do {
            const response = await oauthClient.request<HistoryListResponse>({
              url: GMAIL_HISTORY_URL,
              method: 'GET',
              params: {
                startHistoryId: startHistoryId.toString(),
                historyTypes: 'messageAdded',
                ...(pageToken ? { pageToken } : {}),
              },
            });
            pages += 1;
            for (const record of response.data.history ?? []) {
              for (const added of record.messagesAdded ?? []) {
                if (
                  added.message.labelIds?.some((label) => GMAIL_WATCH_LABEL_IDS.includes(label))
                ) {
                  messageIds.add(added.message.id);
                }
              }
            }
            historyId = BigInt(response.data.historyId);
            pageToken = response.data.nextPageToken;
          } while (pageToken);
        } catch (error) {
          throw toGmailApiError(error);
        }
        span.setAttributes({
          'gmail.history.pages': pages,
          'gmail.history.messages': messageIds.size,
        });
        return { messageIds: [...messageIds], historyId };
      });
    },
  };
}
