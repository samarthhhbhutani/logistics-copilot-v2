import { OAuth2Client } from 'google-auth-library';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';
import { mapWithConcurrency } from '../../utils/concurrency/mapWithConcurrency.js';
import { decodeGmailRawMessage } from '../../utils/mime/parseRawEmail.js';
import type { GoogleOAuthClientCredentials } from './gmailOAuth.js';
import { toGmailApiError } from './gmailApiError.js';
import type { GmailRawMessage } from './gmailMessages.js';

/** One hit of messages.list: ids only, the content is a separate messages.get. */
export interface GmailMessageRef {
  gmailMessageId: string;
  gmailThreadId: string;
}

/** A message of threads.get: the raw message plus its own id (threads.get returns many). */
export interface GmailThreadRawMessage extends GmailRawMessage {
  gmailMessageId: string;
}

/** Gmail's hard ceiling for messages.list is 500; the agent never needs more than a page. */
export const GMAIL_SEARCH_MAX_RESULTS = 50;
/** Parallel messages.get calls while loading a thread; Gmail's per-user quota is 250 units/s. */
const THREAD_MESSAGE_FETCH_CONCURRENCY = 5;

/**
 * The reads the agent's tools need beyond GmailMessages: a search and a whole thread. Kept apart
 * from GmailMessages so the ingestion Lambdas and their fakes do not carry methods they never call.
 */
export interface GmailSearch {
  /**
   * messages.list with Gmail's own search syntax (`from:`, `subject:`, `newer_than:`, ...), newest
   * first. Up to `maxResults` (clamped to GMAIL_SEARCH_MAX_RESULTS). Throws GmailApiError.
   */
  listMessages(input: {
    credentials: GoogleOAuthClientCredentials;
    refreshToken: string;
    query: string;
    maxResults: number;
  }): Promise<GmailMessageRef[]>;
  /**
   * Every message of the thread as raw bytes, oldest first as Gmail returns them. threads.get only
   * serves full/metadata/minimal, so this is one threads.get for the ids plus a messages.get per
   * message. Throws GmailApiError('not_found') for an unknown or deleted thread.
   */
  getThreadRawMessages(input: {
    credentials: GoogleOAuthClientCredentials;
    refreshToken: string;
    gmailThreadId: string;
  }): Promise<GmailThreadRawMessage[]>;
}

interface MessageListResponse {
  messages?: { id: string; threadId: string }[];
}

interface ThreadGetResponse {
  id: string;
  messages?: { id: string }[];
}

interface MessageGetResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate: string;
  raw: string;
}

const GMAIL_USER_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Plain REST via OAuth2Client.request, like gmailMessages. */
export function createGoogleGmailSearch(): GmailSearch {
  return {
    listMessages({ credentials, refreshToken, query, maxResults }) {
      return runInsideSpan('gmail.messages.list', async (span) => {
        const oauthClient = createOAuthClient(credentials, refreshToken);
        let list: MessageListResponse;
        try {
          const response = await oauthClient.request<MessageListResponse>({
            url: `${GMAIL_USER_URL}/messages`,
            method: 'GET',
            params: {
              q: query,
              maxResults: Math.min(Math.max(1, Math.trunc(maxResults)), GMAIL_SEARCH_MAX_RESULTS),
            },
          });
          list = response.data;
        } catch (error) {
          throw toGmailApiError(error);
        }
        const refs = (list.messages ?? []).map((message) => ({
          gmailMessageId: message.id,
          gmailThreadId: message.threadId,
        }));
        span.setAttributes({ 'gmail.messages.found': refs.length });
        return refs;
      });
    },

    getThreadRawMessages({ credentials, refreshToken, gmailThreadId }) {
      return runInsideSpan('gmail.threads.get', async (span) => {
        const oauthClient = createOAuthClient(credentials, refreshToken);
        let thread: ThreadGetResponse;
        try {
          const response = await oauthClient.request<ThreadGetResponse>({
            url: `${GMAIL_USER_URL}/threads/${encodeURIComponent(gmailThreadId)}`,
            method: 'GET',
            params: { format: 'minimal' },
          });
          thread = response.data;
        } catch (error) {
          throw toGmailApiError(error);
        }
        const messageIds = (thread.messages ?? []).map((message) => message.id);
        span.setAttributes({ 'gmail.thread.message_count': messageIds.length });
        return mapWithConcurrency(messageIds, THREAD_MESSAGE_FETCH_CONCURRENCY, async (id) => {
          let message: MessageGetResponse;
          try {
            const response = await oauthClient.request<MessageGetResponse>({
              url: `${GMAIL_USER_URL}/messages/${encodeURIComponent(id)}`,
              method: 'GET',
              params: { format: 'raw' },
            });
            message = response.data;
          } catch (error) {
            throw toGmailApiError(error);
          }
          return {
            gmailMessageId: message.id,
            raw: decodeGmailRawMessage(message.raw),
            threadId: message.threadId,
            labelIds: message.labelIds ?? [],
            internalDate: new Date(Number(message.internalDate)),
            snippet: message.snippet ?? '',
          };
        });
      });
    },
  };
}

function createOAuthClient(credentials: GoogleOAuthClientCredentials, refreshToken: string) {
  const oauthClient = new OAuth2Client({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });
  oauthClient.setCredentials({ refresh_token: refreshToken });
  return oauthClient;
}
