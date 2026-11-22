import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { GmailMessages } from '../connectors/gmail/gmailMessages.js';
import type { GmailSearch } from '../connectors/gmail/gmailSearch.js';
import { createAgentReplyProposer } from './createAgentReplyProposer.js';
import { PROPOSE_REPLY_PROMPT_VERSION } from './prompts/proposeReplyPromptV1.js';

const proposal = {
  subject: 'Re: Rotterdam shipment',
  bodyText: 'Hi Priya,\n\nBest regards,',
  citedGmailMessageIds: ['m-request'],
};

describe('createAgentReplyProposer', () => {
  it('runs the loop with the configured model and a fresh budget, with the tools never touched when the model answers at once', async () => {
    const requests: Record<string, unknown>[] = [];
    const openAiClient = {
      responses: {
        async parse(request: Record<string, unknown>) {
          requests.push(request);
          return {
            id: 'resp-1',
            model: 'gpt-6.1-sol-2026-01-01',
            output: [{ type: 'message', id: 'msg-1', role: 'assistant', content: [] }],
            output_parsed: proposal,
            usage: { input_tokens: 500, output_tokens: 40 },
            incomplete_details: null,
          };
        },
      },
    } as unknown as OpenAI;
    const gmailMessages = {
      getRawMessage: () => Promise.reject(new Error('not expected')),
    } as unknown as Pick<GmailMessages, 'getRawMessage'>;
    const gmailSearch = {
      listMessages: () => Promise.reject(new Error('not expected')),
    } as unknown as GmailSearch;

    const proposer = createAgentReplyProposer({
      openAiClient,
      model: 'gpt-6.1-sol',
      gmailMessages,
      gmailSearch,
    });
    const result = await proposer.propose(
      {
        gmailThreadId: 't-rotterdam',
        anchor: {
          gmailMessageId: 'm-request',
          subject: 'Rotterdam shipment',
          senderName: 'Priya',
          senderEmail: 'priya@suntextiles.example',
          receivedAt: new Date('2025-11-03T12:00:00Z'),
        },
        instruction: 'draft a reply',
      },
      { credentials: { clientId: 'id', clientSecret: 'secret' }, refreshToken: 'rt' },
    );

    expect(proposer.model).toBe('gpt-6.1-sol');
    expect(result).toEqual({
      outcome: 'proposed',
      proposal,
      toolCalls: [],
      usage: { inputTokens: 500, outputTokens: 40 },
      model: 'gpt-6.1-sol-2026-01-01',
      promptVersion: PROPOSE_REPLY_PROMPT_VERSION,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'gpt-6.1-sol' });
  });
});
