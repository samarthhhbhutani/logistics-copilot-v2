import { describe, expect, it } from 'vitest';
import { GmailApiError } from '../connectors/gmail/gmailApiError.js';
import type { AgentMailTools } from './agentMailTools.js';
import type { CompactMailMessage } from './compactMailMessage.js';
import { createAgentToolExecutor } from './executeAgentToolCall.js';
import { ToolBudgetExceededError } from './toolBudget.js';

const message: CompactMailMessage = {
  gmailMessageId: 'm-1',
  gmailThreadId: 't-1',
  date: '2025-11-03T12:00:00.000Z',
  from: 'Priya <priya@suntextiles.example>',
  to: ['ops@bhatia.example'],
  cc: [],
  subject: 'Rotterdam shipment',
  labels: ['INBOX'],
  text: 'Please quote.',
  truncated: false,
  attachments: [],
};

function createFakeTools(failWith?: Error) {
  const calls: { tool: string; input: unknown }[] = [];
  const record = <Result>(tool: string, input: unknown, result: Result) => {
    calls.push({ tool, input });
    if (failWith) return Promise.reject(failWith);
    return Promise.resolve(result);
  };
  const tools: AgentMailTools = {
    searchGmail: (input) =>
      record('searchGmail', input, { query: input.query, messages: [message] }),
    getThread: (input) =>
      record('getThread', input, {
        gmailThreadId: input.gmailThreadId,
        messages: [message],
        omittedOlderMessages: 0,
      }),
    getMessage: (input) => record('getMessage', input, message),
  };
  return { tools, calls };
}

const call = (name: string, args: unknown, callId = 'call-1') => ({
  callId,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

describe('createAgentToolExecutor', () => {
  it('validates the arguments, runs the tool and returns its result as a JSON string under the call id', async () => {
    const { tools, calls } = createFakeTools();
    const executor = createAgentToolExecutor(tools);

    const search = await executor.execute(
      call('search_gmail', { query: 'from:a', maxResults: 5 }, 'c-s'),
    );
    expect(search).toEqual({
      callId: 'c-s',
      output: JSON.stringify({ query: 'from:a', messages: [message] }),
    });
    expect(calls[0]).toEqual({ tool: 'searchGmail', input: { query: 'from:a', maxResults: 5 } });

    await executor.execute(call('search_gmail', { query: 'from:a', maxResults: null }));
    expect(calls[1]!.input).toEqual({ query: 'from:a' });

    const thread = await executor.execute(call('get_thread', { gmailThreadId: 't-1' }));
    expect(JSON.parse(thread.output)).toMatchObject({
      gmailThreadId: 't-1',
      omittedOlderMessages: 0,
    });
    const single = await executor.execute(call('get_message', { gmailMessageId: 'm-1' }));
    expect(JSON.parse(single.output)).toEqual(message);
    expect(calls.map((entry) => entry.tool)).toEqual([
      'searchGmail',
      'searchGmail',
      'getThread',
      'getMessage',
    ]);
  });

  it('answers an unknown tool, malformed JSON and schema violations with a model-visible error, without calling a tool', async () => {
    const { tools, calls } = createFakeTools();
    const executor = createAgentToolExecutor(tools);

    const unknown = await executor.execute(call('send_mail', { to: 'x' }));
    expect(unknown.toolError).toBe('unknown_tool');
    expect(JSON.parse(unknown.output)).toEqual({
      error: 'unknown_tool',
      message: 'no tool named send_mail',
    });

    const malformed = await executor.execute(call('get_thread', '{"gmailThreadId": '));
    expect(malformed.toolError).toBe('invalid_arguments');
    expect(JSON.parse(malformed.output).message).toMatch(/not valid JSON/);

    const violating = await executor.execute(call('search_gmail', { query: '', maxResults: 99 }));
    expect(violating.toolError).toBe('invalid_arguments');
    const detail = JSON.parse(violating.output).message as string;
    expect(detail).toContain('query:');
    expect(detail).toContain('maxResults:');

    expect(calls).toEqual([]);
  });

  it('turns a Gmail not_found into a model-visible error but throws everything the model cannot fix', async () => {
    const notFound = createAgentToolExecutor(
      createFakeTools(new GmailApiError('not_found', 404)).tools,
    );
    const missing = await notFound.execute(call('get_message', { gmailMessageId: 'gone' }));
    expect(missing.toolError).toBe('not_found');
    expect(JSON.parse(missing.output).error).toBe('not_found');

    for (const error of [
      new GmailApiError('rate_limited', 429),
      new GmailApiError('invalid_grant', 400),
      new ToolBudgetExceededError(8),
      new TypeError('bug'),
    ]) {
      const executor = createAgentToolExecutor(createFakeTools(error).tools);
      await expect(executor.execute(call('get_message', { gmailMessageId: 'm-1' }))).rejects.toBe(
        error,
      );
    }
  });
});
