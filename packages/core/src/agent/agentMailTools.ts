import type { GoogleOAuthClientCredentials } from '../connectors/gmail/gmailOAuth.js';
import { GmailApiError } from '../connectors/gmail/gmailApiError.js';
import type { GmailMessages } from '../connectors/gmail/gmailMessages.js';
import type { GmailSearch } from '../connectors/gmail/gmailSearch.js';
import { runInsideSpan } from '../telemetry/runInsideSpan.js';
import { mapWithConcurrency } from '../utils/concurrency/mapWithConcurrency.js';
import {
  COMPACT_MESSAGE_MAX_CHARS,
  COMPACT_PREVIEW_MAX_CHARS,
  toCompactMailMessage,
} from './compactMailMessage.js';
import type { CompactMailMessage } from './compactMailMessage.js';
import type { ToolBudget } from './toolBudget.js';

/** Search hits fetched per call unless the agent asks for fewer; each hit is one messages.get. */
export const SEARCH_DEFAULT_RESULTS = 10;
export const SEARCH_MAX_RESULTS = 20;
/** Parallel messages.get calls behind one search. */
const SEARCH_FETCH_CONCURRENCY = 5;
/** A thread longer than this is cut to its newest messages; `omittedOlderMessages` says how many. */
export const THREAD_MAX_MESSAGES = 30;

export interface SearchGmailResult {
  query: string;
  messages: CompactMailMessage[];
}

export interface GetThreadResult {
  gmailThreadId: string;
  /** Oldest first. The first message keeps any quoted text; later ones drop what they quote. */
  messages: CompactMailMessage[];
  omittedOlderMessages: number;
}

/**
 * The agent's read-only view of one mailbox, straight from Gmail (decision 11-05): nothing the
 * ingestion pipeline stored is consulted, so the agent sees mail exactly as the operator does.
 * Every call spends one unit of the run's ToolBudget and runs in an `agent.tool` span.
 */
export interface AgentMailTools {
  searchGmail(input: { query: string; maxResults?: number }): Promise<SearchGmailResult>;
  getThread(input: { gmailThreadId: string }): Promise<GetThreadResult>;
  getMessage(input: { gmailMessageId: string }): Promise<CompactMailMessage>;
}

export interface AgentMailToolsDependencies {
  gmailMessages: Pick<GmailMessages, 'getRawMessage'>;
  gmailSearch: GmailSearch;
  /** The mailbox the run belongs to; the loop resolves it from the session before the first tool call. */
  mailbox: { credentials: GoogleOAuthClientCredentials; refreshToken: string };
  budget: ToolBudget;
}

export function createAgentMailTools({
  gmailMessages,
  gmailSearch,
  mailbox,
  budget,
}: AgentMailToolsDependencies): AgentMailTools {
  const access = { credentials: mailbox.credentials, refreshToken: mailbox.refreshToken };
  async function tool<Result>(name: string, run: () => Promise<Result>): Promise<Result> {
    budget.consume(name);
    return runInsideSpan('agent.tool', async (span) => {
      span.setAttributes({ 'agent.tool.name': name, 'agent.tool.call_index': budget.used });
      return run();
    });
  }
  return {
    searchGmail({ query, maxResults = SEARCH_DEFAULT_RESULTS }) {
      return tool('search_gmail', async () => {
        const refs = await gmailSearch.listMessages({
          ...access,
          query,
          maxResults: Math.min(Math.max(1, Math.trunc(maxResults)), SEARCH_MAX_RESULTS),
        });
        const previews = await mapWithConcurrency(refs, SEARCH_FETCH_CONCURRENCY, async (ref) => {
          let raw;
          try {
            raw = await gmailMessages.getRawMessage({
              ...access,
              gmailMessageId: ref.gmailMessageId,
            });
          } catch (error) {
            // A hit deleted between messages.list and messages.get drops out; anything else
            // (auth, quota) would hit every remaining fetch too, so it fails the search.
            if (error instanceof GmailApiError && error.code === 'not_found') return undefined;
            throw error;
          }
          return toCompactMailMessage(ref.gmailMessageId, raw, {
            maxChars: COMPACT_PREVIEW_MAX_CHARS,
            quotedMessageKnown: false,
          });
        });
        const messages = previews.filter((preview) => preview !== undefined);
        return { query, messages };
      });
    },
    getThread({ gmailThreadId }) {
      return tool('get_thread', async () => {
        const all = await gmailSearch.getThreadRawMessages({ ...access, gmailThreadId });
        const kept = all.slice(Math.max(0, all.length - THREAD_MAX_MESSAGES));
        const messages = await Promise.all(
          kept.map((message, index) =>
            toCompactMailMessage(message.gmailMessageId, message, {
              maxChars: COMPACT_MESSAGE_MAX_CHARS,
              // Only the true start of the thread may quote mail the agent cannot otherwise see.
              // Once older messages are cut, their quoted copies are cut too; get_message recovers them.
              quotedMessageKnown: index > 0 || kept.length < all.length,
            }),
          ),
        );
        return { gmailThreadId, messages, omittedOlderMessages: all.length - kept.length };
      });
    },
    getMessage({ gmailMessageId }) {
      return tool('get_message', async () => {
        const message = await gmailMessages.getRawMessage({ ...access, gmailMessageId });
        return toCompactMailMessage(gmailMessageId, message, {
          maxChars: COMPACT_MESSAGE_MAX_CHARS,
          quotedMessageKnown: false,
        });
      });
    },
  };
}
