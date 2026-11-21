import type { AgentRun } from '@lc/core';
import type { AgentRunResponse } from '@lc/contract';

export function toAgentRunResponse(run: AgentRun): AgentRunResponse {
  return {
    id: run.id,
    emailId: run.emailId,
    gmailThreadId: run.gmailThreadId,
    instruction: run.instruction,
    status: run.status,
    proposal: run.proposal,
    toolCalls: run.toolCalls,
    model: run.model,
    promptVersion: run.promptVersion,
    usage: run.usage,
    errorCode: run.errorCode,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}
