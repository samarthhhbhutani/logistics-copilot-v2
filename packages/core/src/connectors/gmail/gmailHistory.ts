import { OAuth2Client } from 'google-auth-library';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';
import type { GoogleOAuthClientCredentials } from './gmailOAuth.js';
import { toGmailApiError } from './gmailApiError.js';
import { GMAIL_WATCH_LABEL_IDS } from './gmailWatch.js';

/** Everything history.list reported since the cursor, and the cursor to store next. */
export interface GmailHistoryPage {
  /**
   * Ids of messages that arrived with, or later received, an INBOX or SENT label, deduplicated,
   * in history order. A message can appear twice in history (spam filtered, then moved to the
   * inbox); the processor's emailExists check keeps the second ingest a no-op.
   */
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

interface HistoryMessage {
  id: string;
  labelIds?: string[];
}

/** One history.list record: only the two change types this listing requests are declared. */
export interface GmailHistoryRecord {
  /** New messages; `message.labelIds` are the labels they arrived with. */
  messagesAdded?: { message: HistoryMessage }[];
  /** Existing messages that gained labels; `labelIds` are only the labels added by this change. */
  labelsAdded?: { message: HistoryMessage; labelIds: string[] }[];
}

interface HistoryListResponse {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId: string;
}

const GMAIL_HISTORY_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/history';

/**
 * The query for one history.list page. Both change types are needed: a mail Gmail first filtered
 * to spam only reaches the inbox through a labelAdded record, never a second messageAdded. The key
 * is repeated because the API rejects a comma-joined list, which is what gaxios makes of an array.
 */
export function buildHistoryListParams(startHistoryId: bigint, pageToken?: string) {
  const params = new URLSearchParams({ startHistoryId: startHistoryId.toString() });
  params.append('historyTypes', 'messageAdded');
  params.append('historyTypes', 'labelAdded');
  if (pageToken) params.set('pageToken', pageToken);
  return params;
}

function hasWatchedLabel(labelIds: string[] | undefined) {
  return labelIds?.some((label) => GMAIL_WATCH_LABEL_IDS.includes(label)) ?? false;
}

/**
 * Adds to `messageIds` every message these records put under a watched label, in history order.
 * labelId would filter the request to one label, so the two watched labels are filtered here
 * instead: from the labels a new message arrived with, or from the labels a change added.
 */
export function collectWatchedMessageIds(records: GmailHistoryRecord[], messageIds: Set<string>) {
  for (const record of records) {
    for (const added of record.messagesAdded ?? []) {
      if (hasWatchedLabel(added.message.labelIds)) messageIds.add(added.message.id);
    }
    for (const labelled of record.labelsAdded ?? []) {
      if (hasWatchedLabel(labelled.labelIds)) messageIds.add(labelled.message.id);
    }
  }
}

/** Plain REST via OAuth2Client.request, like gmailWatch. */
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
              params: buildHistoryListParams(startHistoryId, pageToken),
            });
            pages += 1;
            collectWatchedMessageIds(response.data.history ?? [], messageIds);
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
