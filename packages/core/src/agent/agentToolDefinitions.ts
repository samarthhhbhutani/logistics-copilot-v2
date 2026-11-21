import { zodResponsesFunction } from 'openai/helpers/zod';
import { z } from 'zod';
import {
  SEARCH_DEFAULT_RESULTS,
  SEARCH_MAX_RESULTS,
  THREAD_MAX_MESSAGES,
} from './agentMailTools.js';

/**
 * The model-facing contract of the agent's mail tools (roadmap 6.1b): zod schemas for the arguments
 * and the Responses API tool definitions derived from them. Strict mode means every key must be
 * present, so an optional argument is `nullable()` rather than `optional()`.
 *
 * The descriptions assume the 6.2 shape of a run: the operator is looking at one thread and asked
 * for help with it, and the loop hands the model that thread id up front.
 */
export const searchGmailArguments = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Gmail search syntax, e.g. 'in:sent to:customer@example.com newer_than:180d'. Use it to find mail outside the thread you were given, such as the desk's earlier mails to the same sender or its earlier quotes for a similar request.",
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_RESULTS)
    .nullable()
    .describe(
      `How many newest hits to return, 1 to ${SEARCH_MAX_RESULTS}; null means ${SEARCH_DEFAULT_RESULTS}.`,
    ),
});

export const getThreadArguments = z.object({
  gmailThreadId: z
    .string()
    .min(1)
    .describe('The Gmail thread id, as given to you or as returned by search_gmail.'),
});

export const getMessageArguments = z.object({
  gmailMessageId: z
    .string()
    .min(1)
    .describe('The Gmail message id, as returned by search_gmail or get_thread.'),
});

export type SearchGmailArguments = z.infer<typeof searchGmailArguments>;
export type GetThreadArguments = z.infer<typeof getThreadArguments>;
export type GetMessageArguments = z.infer<typeof getMessageArguments>;

export const AGENT_TOOL_NAMES = ['search_gmail', 'get_thread', 'get_message'] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const searchGmailToolDefinition = zodResponsesFunction({
  name: 'search_gmail',
  parameters: searchGmailArguments,
  description:
    'Search the mailbox with Gmail query syntax. Returns the newest matching messages as short previews (ids, headers, first 300 characters of text, attachment names). Follow up with get_thread or get_message for the full text.',
});

export const getThreadToolDefinition = zodResponsesFunction({
  name: 'get_thread',
  parameters: getThreadArguments,
  description: `Read a whole conversation, oldest first, with quoted history removed from replies. Threads longer than ${THREAD_MAX_MESSAGES} messages are cut to the newest ${THREAD_MAX_MESSAGES}; omittedOlderMessages says how many were left out and get_message can fetch any of them by id. Call this first on the thread you were given.`,
});

export const getMessageToolDefinition = zodResponsesFunction({
  name: 'get_message',
  parameters: getMessageArguments,
  description:
    'Read one message in full (up to 4000 characters of text, with quoted history kept) plus its attachment names and sizes. Attachment contents are not available.',
});

/** Pass this array as `tools` to `responses.parse`; `parsed_arguments` is then typed per tool. */
export const agentToolDefinitions = [
  searchGmailToolDefinition,
  getThreadToolDefinition,
  getMessageToolDefinition,
];
