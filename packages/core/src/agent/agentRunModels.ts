import { z } from 'zod';
import type { AgentRunStatus as PrismaAgentRunStatus } from '../db/generated/client.js';

/**
 * running: the loop is talking to the model. proposed: a draft reply is on the row. failed: the run
 * ended without one; errorCode says why.
 */
export type AgentRunStatus = 'running' | 'proposed' | 'failed';

export const AGENT_RUN_STATUS_BY_PRISMA_ENUM: Record<PrismaAgentRunStatus, AgentRunStatus> = {
  RUNNING: 'running',
  PROPOSED: 'proposed',
  FAILED: 'failed',
};

export const PRISMA_ENUM_BY_AGENT_RUN_STATUS: Record<AgentRunStatus, PrismaAgentRunStatus> = {
  running: 'RUNNING',
  proposed: 'PROPOSED',
  failed: 'FAILED',
};

/** The reply the agent proposes; the operator takes it into the composer, nothing is sent from here. */
export const agentProposalSchema = z.object({
  subject: z.string(),
  bodyText: z.string(),
  /** Gmail message ids the proposal drew on (quotes, earlier answers), for the trace view. */
  citedGmailMessageIds: z.array(z.string()),
});
export type AgentProposal = z.infer<typeof agentProposalSchema>;

/** One tool call the model made, as stored on the run for the trace view. */
export const agentToolCallRecordSchema = z.object({
  name: z.string(),
  /** The model's arguments as it sent them (JSON text), so a bad call can be read back verbatim. */
  arguments: z.string(),
  /** `ok`, or the AgentToolErrorCode the model was answered with. */
  outcome: z.string(),
  durationMs: z.number().int().nonnegative(),
});
export type AgentToolCallRecord = z.infer<typeof agentToolCallRecordSchema>;

export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
}

/** One "Ask the copilot" run as the API reads it. `emailId` is the anchor mail (newest inbound at ask time). */
export interface AgentRun {
  id: string;
  emailId: string;
  gmailThreadId: string;
  instruction: string;
  status: AgentRunStatus;
  proposal: AgentProposal | null;
  toolCalls: AgentToolCallRecord[];
  model: string;
  promptVersion: string;
  usage: AgentRunUsage;
  errorCode: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** The jsonb column holds what the loop wrote; anything else reads as no proposal. */
export function fromJsonProposal(value: unknown): AgentProposal | null {
  const parsed = agentProposalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Malformed entries are dropped rather than failing the whole read. */
export function fromJsonToolCalls(value: unknown): AgentToolCallRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = agentToolCallRecordSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
