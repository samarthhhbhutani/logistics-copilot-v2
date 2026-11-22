import type { AgentRun, EmailDetail } from '@lc/core';
import type { AgentCitedMessageResponse, AgentRunResponse } from '@lc/contract';

/**
 * The run as the page reads it. `citedEmails` are the mailbox's stored copies of the proposal's
 * citations (any order, any subset); a citation with no stored copy is still listed, with nulls,
 * so the page can say the copilot read a mail it cannot open.
 */
export function toAgentRunResponse(
  run: AgentRun,
  citedEmails: EmailDetail[] = [],
): AgentRunResponse {
  return {
    id: run.id,
    emailId: run.emailId,
    gmailThreadId: run.gmailThreadId,
    instruction: run.instruction,
    status: run.status,
    proposal: run.proposal
      ? {
          ...run.proposal,
          citedMessages: run.proposal.citedGmailMessageIds.map((gmailMessageId) =>
            toCitedMessage(
              gmailMessageId,
              citedEmails.find((email) => email.gmailMessageId === gmailMessageId),
            ),
          ),
        }
      : null,
    toolCalls: run.toolCalls,
    model: run.model,
    promptVersion: run.promptVersion,
    usage: run.usage,
    errorCode: run.errorCode,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

function toCitedMessage(
  gmailMessageId: string,
  email: EmailDetail | undefined,
): AgentCitedMessageResponse {
  if (!email) {
    return {
      gmailMessageId,
      emailId: null,
      gmailThreadId: null,
      gmailLabel: null,
      sender: null,
      subject: null,
      receivedAt: null,
    };
  }
  return {
    gmailMessageId,
    emailId: email.id,
    gmailThreadId: email.gmailThreadId,
    gmailLabel: email.gmailLabel,
    sender: { name: email.senderName, email: email.senderEmail },
    subject: email.subject,
    receivedAt: email.receivedAt.toISOString(),
  };
}
