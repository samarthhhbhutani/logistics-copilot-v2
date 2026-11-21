import { describe, expect, it } from 'vitest';
import type { GmailMessages, GmailRawMessage } from '../connectors/gmail/gmailMessages.js';
import type { GmailSearch, GmailThreadRawMessage } from '../connectors/gmail/gmailSearch.js';
import { GmailApiError } from '../connectors/gmail/gmailApiError.js';
import { readEmailFixture } from '../utils/mime/fixtures.test-helper.js';
import { SEARCH_MAX_RESULTS, THREAD_MAX_MESSAGES, createAgentMailTools } from './agentMailTools.js';
import { COMPACT_MESSAGE_MAX_CHARS, COMPACT_PREVIEW_MAX_CHARS } from './compactMailMessage.js';
import { ToolBudgetExceededError, createToolBudget } from './toolBudget.js';

const mailbox = {
  credentials: { clientId: 'client', clientSecret: 'secret' },
  refreshToken: 'refresh-1',
};

function rawMessage(fixture: string, threadId: string, labelIds: string[]): GmailRawMessage {
  return {
    raw: readEmailFixture(fixture),
    threadId,
    labelIds,
    internalDate: new Date('2025-11-03T12:00:00Z'),
    snippet: '',
  };
}

/** A mailbox of three fixtures: a customer request, our reply in the same thread, a mail with a PDF. */
function createFakeGmail(overrides: Partial<Record<string, GmailRawMessage>> = {}) {
  const messages: Record<string, GmailRawMessage> = {
    'm-request': rawMessage('gmailPlainTextRequest.eml', 't-rotterdam', ['INBOX']),
    'm-reply': rawMessage('gmailReplyChainHtml.eml', 't-rotterdam', ['SENT']),
    'm-packing': rawMessage('pdfAttachmentPackingList.eml', 't-hamburg', ['INBOX', 'UNREAD']),
    ...overrides,
  };
  const calls: { method: string; input: unknown }[] = [];
  const gmailMessages: Pick<GmailMessages, 'getRawMessage'> = {
    async getRawMessage(input) {
      calls.push({ method: 'getRawMessage', input });
      const message = messages[input.gmailMessageId];
      if (!message) throw new GmailApiError('not_found', 404);
      return message;
    },
  };
  const gmailSearch: GmailSearch = {
    async listMessages(input) {
      calls.push({ method: 'listMessages', input });
      return Object.entries(messages)
        .filter(([, message]) => input.query === '*' || message.threadId === input.query)
        .slice(0, input.maxResults)
        .map(([gmailMessageId, message]) => ({ gmailMessageId, gmailThreadId: message.threadId }));
    },
    async getThreadRawMessages(input) {
      calls.push({ method: 'getThreadRawMessages', input });
      const inThread: GmailThreadRawMessage[] = Object.entries(messages)
        .filter(([, message]) => message.threadId === input.gmailThreadId)
        .map(([gmailMessageId, message]) => ({ gmailMessageId, ...message }));
      if (inThread.length === 0) throw new GmailApiError('not_found', 404);
      return inThread;
    },
  };
  return { gmailMessages, gmailSearch, calls };
}

describe('getMessage', () => {
  it('returns headers, the typed text, labels and attachment names without bytes or HTML', async () => {
    const gmail = createFakeGmail();
    const tools = createAgentMailTools({ ...gmail, mailbox, budget: createToolBudget() });
    const message = await tools.getMessage({ gmailMessageId: 'm-packing' });
    expect(message).toEqual({
      gmailMessageId: 'm-packing',
      gmailThreadId: 't-hamburg',
      date: '2025-11-05T03:45:00.000Z',
      from: 'Anil Shah <anil@globexports.example>',
      to: ['ops@bhatiashipping.example'],
      cc: [],
      subject: 'Quotation needed - packing list attached',
      labels: ['INBOX', 'UNREAD'],
      text: 'Hello,\n\nPlease quote air freight for 12 pallets, 1,500 kg, auto spare parts, Hamburg to Mumbai, ready next Tuesday.\nPacking list attached.\n\nThanks,\nAnil',
      truncated: false,
      attachments: [
        { fileName: 'Packing_List_GE-4471.pdf', contentType: 'application/pdf', sizeBytes: 125 },
      ],
    });
    expect(gmail.calls[0]).toEqual({
      method: 'getRawMessage',
      input: { ...mailbox, gmailMessageId: 'm-packing' },
    });
  });

  it('keeps the quoted history of a single message, since the quoted mail may be all the agent has', async () => {
    const tools = createAgentMailTools({
      ...createFakeGmail(),
      mailbox,
      budget: createToolBudget(),
    });
    const reply = await tools.getMessage({ gmailMessageId: 'm-reply' });
    expect(reply.text).toContain('Rahul\n\nOn Mon, 3 Nov 2025 at 17:41, Priya Nair');
    expect(reply.text.length).toBeLessThanOrEqual(COMPACT_MESSAGE_MAX_CHARS);
  });

  it('lists inline images as nothing: a signature logo is not an attachment to the agent', async () => {
    const tools = createAgentMailTools({
      ...createFakeGmail({ 'm-logo': rawMessage('inlineLogoSignature.eml', 't-cha', ['INBOX']) }),
      mailbox,
      budget: createToolBudget(),
    });
    const message = await tools.getMessage({ gmailMessageId: 'm-logo' });
    expect(message.attachments).toEqual([]);
    expect(message.text).toBe(
      'Hi Rahul,\n\nOur clearance charges for the Mundra import: INR 8,500 per BL plus actuals.\n\nDeepak Rao\nSwift CHA Services',
    );
  });

  it('passes Gmail errors through untouched', async () => {
    const tools = createAgentMailTools({
      ...createFakeGmail(),
      mailbox,
      budget: createToolBudget(),
    });
    await expect(tools.getMessage({ gmailMessageId: 'gone' })).rejects.toMatchObject({
      name: 'GmailApiError',
      code: 'not_found',
    });
  });
});

describe('getThread', () => {
  it('returns the thread oldest first; only the first message keeps quoted history', async () => {
    const tools = createAgentMailTools({
      ...createFakeGmail(),
      mailbox,
      budget: createToolBudget(),
    });
    const thread = await tools.getThread({ gmailThreadId: 't-rotterdam' });
    expect(thread.gmailThreadId).toBe('t-rotterdam');
    expect(thread.omittedOlderMessages).toBe(0);
    expect(thread.messages.map((message) => [message.gmailMessageId, message.labels])).toEqual([
      ['m-request', ['INBOX']],
      ['m-reply', ['SENT']],
    ]);
    expect(thread.messages[1]!.text).toBe(
      'Thanks Priya, noted.\n\nCan you confirm whether the cargo is palletised and the exact pickup address in Bhiwandi?\n\nRahul',
    );
    expect(thread.messages[1]!.cc).toEqual(['accounts@suntextiles.example']);
  });

  it('keeps only the newest THREAD_MAX_MESSAGES, reports how many were left out and drops the quoted copies of the cut history', async () => {
    const long: Record<string, GmailRawMessage> = {};
    for (let index = 0; index < THREAD_MAX_MESSAGES + 5; index++) {
      long[`m-long-${String(index).padStart(2, '0')}`] = rawMessage(
        index === 5 ? 'gmailReplyChainHtml.eml' : 'gmailPlainTextRequest.eml',
        't-long',
        ['INBOX'],
      );
    }
    const tools = createAgentMailTools({
      ...createFakeGmail(long),
      mailbox,
      budget: createToolBudget(),
    });
    const thread = await tools.getThread({ gmailThreadId: 't-long' });
    expect(thread.messages).toHaveLength(THREAD_MAX_MESSAGES);
    expect(thread.omittedOlderMessages).toBe(5);
    expect(thread.messages[0]!.gmailMessageId).toBe('m-long-05');
    expect(thread.messages[0]!.text).toBe(
      'Thanks Priya, noted.\n\nCan you confirm whether the cargo is palletised and the exact pickup address in Bhiwandi?\n\nRahul',
    );
  });
});

describe('searchGmail', () => {
  it('lists by Gmail query then fetches each hit as a short preview', async () => {
    const gmail = createFakeGmail();
    const tools = createAgentMailTools({ ...gmail, mailbox, budget: createToolBudget() });
    const result = await tools.searchGmail({ query: 't-rotterdam' });
    expect(result.query).toBe('t-rotterdam');
    expect(result.messages.map((message) => message.gmailMessageId)).toEqual([
      'm-request',
      'm-reply',
    ]);
    for (const message of result.messages) {
      expect(message.text.length).toBeLessThanOrEqual(COMPACT_PREVIEW_MAX_CHARS);
    }
    expect(result.messages[0]!.truncated).toBe(false);
    expect(gmail.calls.map((call) => call.method)).toEqual([
      'listMessages',
      'getRawMessage',
      'getRawMessage',
    ]);
    expect(gmail.calls[0]!.input).toMatchObject({ query: 't-rotterdam', maxResults: 10 });
  });

  it('drops a hit deleted after the listing but fails on errors that would hit every fetch', async () => {
    const gmail = createFakeGmail();
    const getRawMessage = gmail.gmailMessages.getRawMessage.bind(gmail.gmailMessages);
    let failWith: GmailApiError = new GmailApiError('not_found', 404);
    gmail.gmailMessages.getRawMessage = async (input) => {
      if (input.gmailMessageId === 'm-request') throw failWith;
      return getRawMessage(input);
    };
    const tools = createAgentMailTools({ ...gmail, mailbox, budget: createToolBudget() });
    const result = await tools.searchGmail({ query: 't-rotterdam' });
    expect(result.messages.map((message) => message.gmailMessageId)).toEqual(['m-reply']);

    failWith = new GmailApiError('rate_limited', 429);
    await expect(tools.searchGmail({ query: 't-rotterdam' })).rejects.toBe(failWith);
  });

  it('clamps maxResults to the tool ceiling and never below one', async () => {
    const gmail = createFakeGmail();
    const tools = createAgentMailTools({ ...gmail, mailbox, budget: createToolBudget() });
    await tools.searchGmail({ query: '*', maxResults: 500 });
    await tools.searchGmail({ query: '*', maxResults: 0 });
    const listCalls = gmail.calls.filter((call) => call.method === 'listMessages');
    expect(listCalls.map((call) => (call.input as { maxResults: number }).maxResults)).toEqual([
      SEARCH_MAX_RESULTS,
      1,
    ]);
  });
});

describe('tool budget', () => {
  it('counts tool calls, not Gmail calls, and refuses the call past the limit before touching Gmail', async () => {
    const gmail = createFakeGmail();
    const budget = createToolBudget(2);
    const tools = createAgentMailTools({ ...gmail, mailbox, budget });
    await tools.searchGmail({ query: '*' });
    await tools.getMessage({ gmailMessageId: 'm-reply' });
    expect(budget.used).toBe(2);
    expect(budget.calls).toEqual(['search_gmail', 'get_message']);
    const gmailCallsBefore = gmail.calls.length;
    await expect(tools.getThread({ gmailThreadId: 't-rotterdam' })).rejects.toBeInstanceOf(
      ToolBudgetExceededError,
    );
    expect(gmail.calls).toHaveLength(gmailCallsBefore);
  });
});
