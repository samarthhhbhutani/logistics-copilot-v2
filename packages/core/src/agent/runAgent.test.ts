import type OpenAI from 'openai';
import { APIError } from 'openai';
import { describe, expect, it } from 'vitest';
import { GmailApiError } from '../connectors/gmail/gmailApiError.js';
import type { AgentMailTools } from './agentMailTools.js';
import type { CompactMailMessage } from './compactMailMessage.js';
import {
  DEFAULT_AGENT_INSTRUCTION,
  PROPOSE_REPLY_PROMPT_VERSION,
  PROPOSE_REPLY_SYSTEM_PROMPT,
} from './prompts/proposeReplyPromptV1.js';
import { AGENT_MAX_MODEL_TURNS, runAgent, TOOL_BUDGET_EXHAUSTED_CODE } from './runAgent.js';
import { createToolBudget } from './toolBudget.js';
import type { ToolBudget } from './toolBudget.js';

const anchor = {
  gmailMessageId: 'm-request',
  subject: 'Rotterdam shipment',
  senderName: 'Priya',
  senderEmail: 'priya@suntextiles.example',
  receivedAt: new Date('2025-11-03T12:00:00Z'),
};
const input = { gmailThreadId: 't-rotterdam', anchor, instruction: DEFAULT_AGENT_INSTRUCTION };
const proposal = {
  subject: 'Re: Rotterdam shipment',
  bodyText: 'Hi Priya,\n\n- USD 1,450 per 40HC\n\nBest regards,',
  citedGmailMessageIds: ['m-request', 'm-quote'],
};

const message: CompactMailMessage = {
  gmailMessageId: 'm-quote',
  gmailThreadId: 't-carrier',
  date: '2025-11-04T09:00:00.000Z',
  from: 'ops@carrier.example',
  to: ['ops@bhatia.example'],
  cc: [],
  subject: 'Quote Rotterdam',
  labels: ['INBOX'],
  text: 'USD 1,450 per 40HC',
  truncated: false,
  attachments: [],
};

type Turn =
  | {
      output: unknown[];
      output_parsed?: unknown;
      usage?: { input_tokens: number; output_tokens: number };
      incomplete?: string;
      model?: string;
    }
  | Error;

const functionCall = (callId: string, name: string, args: unknown) => ({
  type: 'function_call',
  id: `fc-${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
});
const reasoning = { type: 'reasoning', id: 'rs-1', summary: [] };
const finalMessage = {
  type: 'message',
  id: 'msg-1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: JSON.stringify(proposal), annotations: [] }],
};

/** Plays the scripted turns in order; records every request so the test can inspect the conversation. */
function fakeOpenAi(turns: Turn[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    responses: {
      async parse(request: Record<string, unknown>) {
        // The loop mutates its conversation array in place; keep what this request saw.
        requests.push({ ...request, input: [...(request.input as unknown[])] });
        const turn = turns[requests.length - 1];
        if (!turn) throw new Error(`no scripted turn ${requests.length}`);
        if (turn instanceof Error) throw turn;
        return {
          id: `resp-${requests.length}`,
          model: turn.model ?? 'gpt-6.1-sol-2026-01-01',
          output: turn.output,
          output_parsed: turn.output_parsed ?? null,
          usage: turn.usage ?? { input_tokens: 100, output_tokens: 10 },
          incomplete_details: turn.incomplete ? { reason: turn.incomplete } : null,
        };
      },
    },
  } as unknown as OpenAI;
  return { client, requests };
}

/** Like the real tools, every call spends one unit of the run's budget before anything else. */
function fakeTools(budget: ToolBudget, failWith?: Error) {
  const calls: string[] = [];
  const answer = <Result>(name: string, result: Result) => {
    budget.consume(name);
    calls.push(name);
    return failWith ? Promise.reject(failWith) : Promise.resolve(result);
  };
  const tools: AgentMailTools = {
    searchGmail: ({ query }) => answer('searchGmail', { query, messages: [message] }),
    getThread: ({ gmailThreadId }) =>
      answer('getThread', { gmailThreadId, messages: [message], omittedOlderMessages: 0 }),
    getMessage: () => answer('getMessage', message),
  };
  return { tools, calls };
}

let clock = 0;
const now = () => (clock += 25);

describe('runAgent', () => {
  it('reads the thread, searches, continues each turn from the previous response and ends with the parsed proposal and a trace', async () => {
    const { client, requests } = fakeOpenAi([
      {
        output: [reasoning, functionCall('c1', 'get_thread', { gmailThreadId: 't-rotterdam' })],
        usage: { input_tokens: 400, output_tokens: 20 },
      },
      {
        output: [
          functionCall('c2', 'search_gmail', {
            query: 'subject:Rotterdam quote',
            maxResults: null,
          }),
        ],
        usage: { input_tokens: 900, output_tokens: 30 },
      },
      {
        output: [finalMessage],
        output_parsed: proposal,
        usage: { input_tokens: 1300, output_tokens: 120 },
      },
    ]);
    const budget = createToolBudget();
    const { tools, calls } = fakeTools(budget);
    const result = await runAgent(input, {
      openAiClient: client,
      model: 'gpt-6.1-sol',
      tools,
      budget,
      now,
    });

    expect(result).toEqual({
      outcome: 'proposed',
      proposal,
      toolCalls: [
        {
          name: 'get_thread',
          arguments: '{"gmailThreadId":"t-rotterdam"}',
          outcome: 'ok',
          durationMs: 25,
        },
        {
          name: 'search_gmail',
          arguments: '{"query":"subject:Rotterdam quote","maxResults":null}',
          outcome: 'ok',
          durationMs: 25,
        },
      ],
      usage: { inputTokens: 2600, outputTokens: 170 },
      model: 'gpt-6.1-sol-2026-01-01',
      promptVersion: PROPOSE_REPLY_PROMPT_VERSION,
    });
    expect(calls).toEqual(['getThread', 'searchGmail']);

    expect(requests).toHaveLength(3);
    const first = requests[0]!;
    expect(first).toMatchObject({ model: 'gpt-6.1-sol', tool_choice: 'auto', store: true });
    expect(first.previous_response_id).toBeUndefined();
    expect((first.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
      'search_gmail',
      'get_thread',
      'get_message',
    ]);
    expect(first.instructions).toBe(PROPOSE_REPLY_SYSTEM_PROMPT);
    const firstInput = first.input as { role?: string; content?: string }[];
    expect(firstInput).toHaveLength(1);
    expect(firstInput[0]!.content).toContain('Thread id: t-rotterdam');
    expect(firstInput[0]!.content).toContain(
      'id m-request, from Priya <priya@suntextiles.example>',
    );
    expect(firstInput[0]!.content).toContain(DEFAULT_AGENT_INSTRUCTION);

    // Later turns continue the stored response and carry only the new tool outputs.
    expect(requests[1]).toMatchObject({
      previous_response_id: 'resp-1',
      instructions: PROPOSE_REPLY_SYSTEM_PROMPT,
    });
    const secondInput = requests[1]!.input as {
      type?: string;
      call_id?: string;
      output?: string;
    }[];
    expect(secondInput.map((item) => [item.type, item.call_id])).toEqual([
      ['function_call_output', 'c1'],
    ]);
    expect(JSON.parse(secondInput[0]!.output!)).toMatchObject({
      gmailThreadId: 't-rotterdam',
      omittedOlderMessages: 0,
    });
    expect(requests[2]).toMatchObject({ previous_response_id: 'resp-2' });
    const thirdInput = requests[2]!.input as { type?: string; call_id?: string }[];
    expect(thirdInput.map((item) => [item.type, item.call_id])).toEqual([
      ['function_call_output', 'c2'],
    ]);
  });

  it('answers calls past the budget with a budget error, then forces a tool-free final turn', async () => {
    const { client, requests } = fakeOpenAi([
      {
        output: [
          functionCall('c1', 'get_thread', { gmailThreadId: 't-rotterdam' }),
          functionCall('c2', 'get_message', { gmailMessageId: 'm-quote' }),
          functionCall('c3', 'get_message', { gmailMessageId: 'm-other' }),
        ],
      },
      { output: [finalMessage], output_parsed: proposal },
    ]);
    const budget = createToolBudget(2);
    const { tools, calls } = fakeTools(budget);
    const result = await runAgent(input, {
      openAiClient: client,
      model: 'gpt-6.1-sol',
      tools,
      budget,
      now,
    });

    expect(result.outcome).toBe('proposed');
    expect(result.toolCalls.map((call) => call.outcome)).toEqual([
      'ok',
      'ok',
      TOOL_BUDGET_EXHAUSTED_CODE,
    ]);
    expect(calls).toEqual(['getThread', 'getMessage']);
    const secondInput = requests[1]!.input as {
      type?: string;
      call_id?: string;
      output?: string;
    }[];
    const exhausted = secondInput.find(
      (item) => item.call_id === 'c3' && item.type === 'function_call_output',
    );
    expect(JSON.parse(exhausted!.output!)).toMatchObject({ error: TOOL_BUDGET_EXHAUSTED_CODE });
    expect(requests[1]).toMatchObject({ tool_choice: 'none' });
  });

  it('passes model-visible tool errors back and keeps going', async () => {
    const { client, requests } = fakeOpenAi([
      { output: [functionCall('c1', 'get_message', { gmailMessageId: 'gone' })] },
      { output: [finalMessage], output_parsed: proposal },
    ]);
    const budget = createToolBudget();
    const { tools } = fakeTools(budget, new GmailApiError('not_found', 404));
    const result = await runAgent(input, {
      openAiClient: client,
      model: 'gpt-6.1-sol',
      tools,
      budget,
      now,
    });
    expect(result.outcome).toBe('proposed');
    expect(result.toolCalls[0]!.outcome).toBe('not_found');
    const secondInput = requests[1]!.input as { type?: string; output?: string }[];
    expect(JSON.parse(secondInput.at(-1)!.output!)).toMatchObject({ error: 'not_found' });
  });

  it('fails the run on errors the model cannot fix, with the tool call recorded as thrown', async () => {
    const { client } = fakeOpenAi([
      { output: [functionCall('c1', 'get_thread', { gmailThreadId: 't-rotterdam' })] },
    ]);
    const budget = createToolBudget();
    const { tools } = fakeTools(
      budget,
      new GmailApiError('invalid_grant', 400, 'Token has been expired or revoked.'),
    );
    const result = await runAgent(input, {
      openAiClient: client,
      model: 'gpt-6.1-sol',
      tools,
      budget,
      now,
    });
    expect(result).toMatchObject({
      outcome: 'failed',
      errorCode: 'invalid_grant',
      detail: 'invalid_grant: Token has been expired or revoked.',
      toolCalls: [{ name: 'get_thread', outcome: 'threw' }],
    });
  });

  it('maps provider failures, truncated output, a final turn without a proposal and the turn cap', async () => {
    const run = (turns: Turn[]) => {
      const budget = createToolBudget();
      return runAgent(input, {
        openAiClient: fakeOpenAi(turns).client,
        model: 'gpt-6.1-sol',
        tools: fakeTools(budget).tools,
        budget,
        now,
      });
    };

    await expect(
      run([new APIError(429, { error: { message: 'slow down' } }, 'slow down', new Headers())]),
    ).resolves.toMatchObject({
      outcome: 'failed',
      errorCode: 'llm_retry',
    });
    await expect(
      run([new APIError(400, { error: { message: 'bad request' } }, 'bad request', new Headers())]),
    ).resolves.toMatchObject({
      outcome: 'failed',
      errorCode: 'llm_failed',
    });
    await expect(
      run([{ output: [finalMessage], incomplete: 'max_output_tokens' }]),
    ).resolves.toMatchObject({
      outcome: 'failed',
      errorCode: 'incomplete_output',
      detail: 'max_output_tokens',
    });
    await expect(
      run([{ output: [finalMessage], output_parsed: { subject: 'only' } }]),
    ).resolves.toMatchObject({
      outcome: 'failed',
      errorCode: 'no_proposal',
    });

    const endless = Array.from({ length: AGENT_MAX_MODEL_TURNS + 1 }, (_, index) => ({
      output: [functionCall(`c${index}`, 'get_thread', { gmailThreadId: 't-rotterdam' })],
    }));
    const roomy = createToolBudget(100);
    const capped = await runAgent(input, {
      openAiClient: fakeOpenAi(endless).client,
      model: 'gpt-6.1-sol',
      tools: fakeTools(roomy).tools,
      budget: roomy,
      now,
    });
    expect(capped).toMatchObject({ outcome: 'failed', errorCode: 'turn_limit' });
    expect(capped.toolCalls).toHaveLength(AGENT_MAX_MODEL_TURNS);
  });
});
