import type OpenAI from 'openai';
import type { GmailMessages } from '../connectors/gmail/gmailMessages.js';
import type { GoogleOAuthClientCredentials } from '../connectors/gmail/gmailOAuth.js';
import type { GmailSearch } from '../connectors/gmail/gmailSearch.js';
import { createAgentMailTools } from './agentMailTools.js';
import { runAgent } from './runAgent.js';
import type { RunAgentInput, RunAgentResult } from './runAgent.js';
import { createToolBudget } from './toolBudget.js';

/** What the tools need to read the mailbox the run belongs to. */
export interface AgentMailboxAccess {
  credentials: GoogleOAuthClientCredentials;
  refreshToken: string;
}

/**
 * One copilot run against one mailbox: what the API calls once it has written the running row.
 * `model` is what the row records; the proposer is the one place that knows it.
 */
export interface AgentReplyProposer {
  model: string;
  propose(input: RunAgentInput, mailbox: AgentMailboxAccess): Promise<RunAgentResult>;
}

export interface AgentReplyProposerDependencies {
  openAiClient: OpenAI;
  model: string;
  gmailMessages: Pick<GmailMessages, 'getRawMessage'>;
  gmailSearch: GmailSearch;
}

/** Wires a fresh tool budget and the mailbox's Gmail tools around runAgent for every run. */
export function createAgentReplyProposer({
  openAiClient,
  model,
  gmailMessages,
  gmailSearch,
}: AgentReplyProposerDependencies): AgentReplyProposer {
  return {
    model,
    propose(input, mailbox) {
      const budget = createToolBudget();
      const tools = createAgentMailTools({ gmailMessages, gmailSearch, mailbox, budget });
      return runAgent(input, { openAiClient, model, tools, budget });
    },
  };
}
