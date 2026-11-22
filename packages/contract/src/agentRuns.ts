import { z } from 'zod';
import { gmailLabelSchema } from './emails.js';

export const MAX_AGENT_INSTRUCTION_LENGTH = 2000;

/** Gmail thread ids are opaque hex strings; anything else can match nothing. */
export const gmailThreadIdSchema = z.string().regex(/^[0-9a-f]{1,32}$/);

/**
 * POST /v1/mailbox/agent/runs: ask the copilot for a reply to a thread. The reply answers the
 * thread's newest inbound mail. `instruction` omitted means the default ask: write in the format of
 * the desk's earlier mail to this sender, with costs from an earlier similar quote for a shipment
 * request. 202 AgentRunResponse (status running); poll GET /:agentRunId until it is not.
 *   404 thread_not_found (no inbound mail of that thread in the mailbox) | mailbox_not_found
 *   409 mailbox_not_connected | google_client_not_configured
 *   503 agent_unavailable (no model configured)
 */
export const createAgentRunRequestSchema = z.object({
  gmailThreadId: gmailThreadIdSchema,
  instruction: z.string().trim().min(1).max(MAX_AGENT_INSTRUCTION_LENGTH).optional(),
});
export type CreateAgentRunRequest = z.infer<typeof createAgentRunRequestSchema>;

export const agentRunStatusSchema = z.enum(['running', 'proposed', 'failed']);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

/**
 * One mail the proposal drew on, as far as the mailbox stores it: `emailId` and the rest are null
 * when the copilot read a Gmail message ingestion never saw, so the page can still say it was used.
 */
export const agentCitedMessageResponseSchema = z.object({
  gmailMessageId: z.string(),
  emailId: z.uuid().nullable(),
  gmailThreadId: z.string().nullable(),
  gmailLabel: gmailLabelSchema.nullable(),
  sender: z.object({ name: z.string(), email: z.string().nullable() }).nullable(),
  subject: z.string().nullable(),
  receivedAt: z.iso.datetime().nullable(),
});
export type AgentCitedMessageResponse = z.infer<typeof agentCitedMessageResponseSchema>;

/** The proposed reply; the operator takes it into the reply composer, nothing is sent from here. */
export const agentProposalResponseSchema = z.object({
  subject: z.string(),
  bodyText: z.string(),
  /** Gmail message ids the proposal drew on: the mail answered, the format source, the cost source. */
  citedGmailMessageIds: z.array(z.string()),
  /** The same citations, in the same order, resolved against the mailbox's stored mail at read time. */
  citedMessages: z.array(agentCitedMessageResponseSchema),
});
export type AgentProposalResponse = z.infer<typeof agentProposalResponseSchema>;

export const agentToolCallResponseSchema = z.object({
  name: z.string(),
  arguments: z.string(),
  outcome: z.string(),
  durationMs: z.number().int().nonnegative(),
});

/** One copilot run as the thread view reads it; `proposal` is set only when status is proposed. */
export const agentRunResponseSchema = z.object({
  id: z.uuid(),
  /** The inbound mail the proposal answers. */
  emailId: z.uuid(),
  gmailThreadId: z.string(),
  instruction: z.string(),
  status: agentRunStatusSchema,
  proposal: agentProposalResponseSchema.nullable(),
  toolCalls: z.array(agentToolCallResponseSchema),
  model: z.string(),
  promptVersion: z.string(),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
  /** Why a failed run stopped (llm_retry, tool_budget..., turn_limit, run_crashed); null otherwise. */
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;
