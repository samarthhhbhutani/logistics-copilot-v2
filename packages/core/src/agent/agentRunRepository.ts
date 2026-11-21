import type { Prisma } from '../db/generated/client.js';
import type { PrismaClient } from '../db/prismaClient.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';
import {
  AGENT_RUN_STATUS_BY_PRISMA_ENUM,
  fromJsonProposal,
  fromJsonToolCalls,
} from './agentRunModels.js';
import type {
  AgentProposal,
  AgentRun,
  AgentRunUsage,
  AgentToolCallRecord,
} from './agentRunModels.js';

/** Everything known when the operator asks; the row is written with status running. */
export interface AgentRunToCreate {
  /** The anchor mail: newest inbound message of the thread for this mailbox, resolved by the API. */
  emailId: string;
  gmailThreadId: string;
  instruction: string;
  model: string;
  promptVersion: string;
}

/** What the loop knows when it stops, whichever way it stopped. */
export interface AgentRunOutcomeDetails {
  toolCalls: AgentToolCallRecord[];
  usage: AgentRunUsage;
}

export interface AgentRunRepository {
  create(scope: MailboxScope, run: AgentRunToCreate): Promise<AgentRun>;
  /** The run in this mailbox, or null: another mailbox's run id is "not found", never "forbidden". */
  findAgentRun(scope: MailboxScope, agentRunId: string): Promise<AgentRun | null>;
  /** Newest first; what the thread view shows under the conversation. */
  listForThread(scope: MailboxScope, gmailThreadId: string, limit: number): Promise<AgentRun[]>;
  /** running -> proposed. `moved: false` when the row is not running (finished twice, or unknown). */
  markProposed(
    scope: MailboxScope,
    agentRunId: string,
    details: AgentRunOutcomeDetails & { proposal: AgentProposal },
  ): Promise<{ moved: boolean }>;
  /** running -> failed. Same `moved` rule. */
  markFailed(
    scope: MailboxScope,
    agentRunId: string,
    details: AgentRunOutcomeDetails & { errorCode: string },
  ): Promise<{ moved: boolean }>;
}

const AGENT_RUN_SELECT = {
  id: true,
  emailId: true,
  gmailThreadId: true,
  instruction: true,
  status: true,
  proposal: true,
  toolCalls: true,
  model: true,
  promptVersion: true,
  inputTokens: true,
  outputTokens: true,
  errorCode: true,
  createdAt: true,
  finishedAt: true,
} satisfies Prisma.AgentRunSelect;

type AgentRunRow = Prisma.AgentRunGetPayload<{ select: typeof AGENT_RUN_SELECT }>;

export function createPrismaAgentRunRepository(prismaClient: PrismaClient): AgentRunRepository {
  async function finish(
    scope: MailboxScope,
    agentRunId: string,
    data: Prisma.AgentRunUpdateManyMutationInput,
  ): Promise<{ moved: boolean }> {
    const { count } = await prismaClient.agentRun.updateMany({
      where: { id: agentRunId, ...scope, status: 'RUNNING' },
      data: { ...data, finishedAt: new Date() },
    });
    return { moved: count === 1 };
  }

  return {
    async create(scope, run) {
      const row = await prismaClient.agentRun.create({
        data: { ...scope, ...run },
        select: AGENT_RUN_SELECT,
      });
      return toAgentRun(row);
    },

    async findAgentRun(scope, agentRunId) {
      const row = await prismaClient.agentRun.findFirst({
        where: { id: agentRunId, ...scope },
        select: AGENT_RUN_SELECT,
      });
      return row ? toAgentRun(row) : null;
    },

    async listForThread(scope, gmailThreadId, limit) {
      const rows = await prismaClient.agentRun.findMany({
        where: { ...scope, gmailThreadId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: AGENT_RUN_SELECT,
      });
      return rows.map(toAgentRun);
    },

    markProposed(scope, agentRunId, { proposal, toolCalls, usage }) {
      return finish(scope, agentRunId, {
        status: 'PROPOSED',
        proposal,
        toolCalls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        errorCode: null,
      });
    },

    markFailed(scope, agentRunId, { errorCode, toolCalls, usage }) {
      return finish(scope, agentRunId, {
        status: 'FAILED',
        toolCalls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        errorCode,
      });
    },
  };
}

function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    emailId: row.emailId,
    gmailThreadId: row.gmailThreadId,
    instruction: row.instruction,
    status: AGENT_RUN_STATUS_BY_PRISMA_ENUM[row.status],
    proposal: fromJsonProposal(row.proposal),
    toolCalls: fromJsonToolCalls(row.toolCalls),
    model: row.model,
    promptVersion: row.promptVersion,
    usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens },
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}
