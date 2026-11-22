import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import { DEFAULT_AGENT_INSTRUCTION, PROPOSE_REPLY_PROMPT_VERSION } from '@lc/core';
import type {
  AgentReplyProposer,
  AgentRun,
  AgentRunRepository,
  EmailDetail,
  EmailReadRepository,
  EncryptionUtil,
  MailboxConnectionRepository,
  MailboxScope,
  TenantRepository,
} from '@lc/core';
import { createAgentRunRequestSchema } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { loadConnectedMailbox } from '../gmail/loadConnectedMailbox.js';
import type { ConnectedMailbox } from '../gmail/loadConnectedMailbox.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';
import { parseRequestBody } from '../http/parseRequestBody.js';
import { toAgentRunResponse } from './agentRunResponses.js';

export interface AgentRunsRouterDependencies {
  agentRunRepository: AgentRunRepository;
  emailReadRepository: EmailReadRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  tenantRepository: TenantRepository;
  encryptionUtil: EncryptionUtil;
  /** Undefined without an OpenAI key, so POST answers 503. */
  agentReplyProposer: AgentReplyProposer | undefined;
  requireSession: RequestHandler;
}

/** A run whose process died mid-loop never calls the repository; this code marks the ones that threw. */
export const RUN_CRASHED_CODE = 'run_crashed';

/**
 * The copilot's runs for the signed-in mailbox, mounted at /v1/mailbox/agent/runs (roadmap 6.2).
 *   POST /             { gmailThreadId, instruction? }
 *     202 AgentRunResponse (running)   404 thread_not_found (no inbound mail of the thread here) |
 *                                          mailbox_not_found
 *                                      409 mailbox_not_connected | google_client_not_configured
 *                                      503 agent_unavailable
 *   GET  /:agentRunId  200 AgentRunResponse   404 outside the session's mailbox
 *
 * The run is written as running before the response and finished in this process afterwards:
 * the loop takes tens of seconds, longer than a request should hold, and the API is a long-lived
 * process (Railway), so no queue is needed. The client polls GET until the status moves.
 */
export function createAgentRunsRouter({
  agentRunRepository,
  emailReadRepository,
  mailboxConnectionRepository,
  tenantRepository,
  encryptionUtil,
  agentReplyProposer,
  requireSession,
}: AgentRunsRouterDependencies): Router {
  const router = express.Router();

  router.post('/', requireSession, async (request, response) => {
    if (!agentReplyProposer) {
      response.status(503).json({ error: 'agent_unavailable' });
      return;
    }
    const body = parseRequestBody(createAgentRunRequestSchema, request.body);
    const scope = getSession(response);
    const anchor = newestInboundEmail(
      await emailReadRepository.listThreadEmails(scope, body.gmailThreadId),
    );
    if (!anchor) throw createHttpError(404, 'thread_not_found');
    const mailbox = await loadConnectedMailbox(
      { mailboxConnectionRepository, tenantRepository, encryptionUtil },
      scope,
    );
    const run = await agentRunRepository.create(scope, {
      emailId: anchor.id,
      gmailThreadId: body.gmailThreadId,
      instruction: body.instruction ?? DEFAULT_AGENT_INSTRUCTION,
      model: agentReplyProposer.model,
      promptVersion: PROPOSE_REPLY_PROMPT_VERSION,
    });
    // Not awaited: the response goes out now, the row moves when the loop ends.
    void finishRun(agentReplyProposer, scope, run, anchor, mailbox);
    response.status(202).json(toAgentRunResponse(run));
  });

  router.get('/:agentRunId', requireSession, async (request, response) => {
    const agentRunId = parseIdOr404(request.params.agentRunId);
    const run = await agentRunRepository.findAgentRun(getSession(response), agentRunId);
    if (!run) throw createHttpError(404, 'not_found');
    response.json(toAgentRunResponse(run));
  });

  /** Runs the loop and records how it ended; nothing here can reach the already-sent response. */
  async function finishRun(
    proposer: AgentReplyProposer,
    scope: MailboxScope,
    run: AgentRun,
    anchor: EmailDetail,
    mailbox: ConnectedMailbox,
  ): Promise<void> {
    try {
      const result = await proposer.propose(
        {
          gmailThreadId: run.gmailThreadId,
          anchor: {
            gmailMessageId: anchor.gmailMessageId,
            subject: anchor.subject,
            senderName: anchor.senderName,
            senderEmail: anchor.senderEmail,
            receivedAt: anchor.receivedAt,
          },
          instruction: run.instruction,
        },
        { credentials: mailbox.credentials, refreshToken: mailbox.refreshToken },
      );
      const details = { toolCalls: result.toolCalls, usage: result.usage };
      if (result.outcome === 'proposed') {
        await agentRunRepository.markProposed(scope, run.id, {
          ...details,
          proposal: result.proposal,
        });
      } else {
        await agentRunRepository.markFailed(scope, run.id, {
          ...details,
          errorCode: result.errorCode,
        });
      }
    } catch (error) {
      console.error(`agent run ${run.id} crashed`, error);
      await agentRunRepository
        .markFailed(scope, run.id, {
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          errorCode: RUN_CRASHED_CODE,
        })
        .catch((markError: unknown) =>
          console.error(`agent run ${run.id} could not be marked failed`, markError),
        );
    }
  }

  return router;
}

/** The mail the reply answers: the thread's newest inbound message in this mailbox. */
function newestInboundEmail(threadEmails: EmailDetail[]): EmailDetail | undefined {
  // listThreadEmails is oldest first.
  return threadEmails.filter((email) => email.gmailLabel === 'inbox').at(-1);
}
