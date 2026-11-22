// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResponse, EmailDetailResponse, SentMailResponse } from '@lc/contract';
import { frontendApi, FrontendApiError } from './frontendApi.js';
import { newestInboundEmail, ReplyComposer } from './replyComposer.js';
import { AGENT_RUN_POLL_MS } from './useAgentRun.js';

const session = {
  tenantId: '00000000-0000-4000-8000-000000000002',
  mailboxId: '00000000-0000-4000-8000-000000000001',
};
function email(id: string, gmailLabel: EmailDetailResponse['gmailLabel']): EmailDetailResponse {
  return {
    id,
    gmailThreadId: 'abc123',
    gmailLabel,
    sender: { name: 'Ravi', email: 'ravi@example.com' },
    toRecipients: [{ name: '', address: 'ops@example.com' }],
    ccRecipients: [],
    subject: 'Rates',
    snippet: '',
    receivedAt: '2026-11-22T09:00:00.000Z',
    classification: null,
    rfcMessageId: null,
    bodyText: 'Please quote.',
    bodyHtml: null,
  };
}
const inbound = email('00000000-0000-4000-8000-000000000011', 'inbox');
function sentMail(
  id: string,
  status: SentMailResponse['status'],
  errorCode: string | null = null,
  ccRecipients: SentMailResponse['ccRecipients'] = [],
) {
  return {
    id,
    kind: 'reply',
    status,
    inReplyToEmailId: inbound.id,
    rfqId: null,
    vendorId: null,
    vendorContactId: null,
    gmailThreadId: 'abc123',
    rfcMessageId: '<x@example.com>',
    toRecipients: [{ name: 'Ravi', address: 'ravi@example.com' }],
    ccRecipients,
    subject: 'Re: Rates',
    bodyText: 'Dear Ravi',
    gmailMessageId: status === 'sent' ? 'gm-9' : null,
    errorCode,
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:01.000Z',
  } satisfies SentMailResponse;
}
/** Answers each send with the given status, under whatever id the composer minted. */
function answerSends(...statuses: (SentMailResponse['status'] | Error)[]) {
  const sendReply = vi.spyOn(frontendApi, 'sendReply');
  for (const status of statuses) {
    if (status instanceof Error) sendReply.mockRejectedValueOnce(status);
    else
      sendReply.mockImplementationOnce((_session, _emailId, body) =>
        Promise.resolve(
          sentMail(
            body.sentMailId,
            status,
            status === 'failed' ? 'bad_request' : null,
            (body.cc ?? []).map((recipient) => ({ name: recipient.name ?? '', ...recipient })),
          ),
        ),
      );
  }
  return sendReply;
}

let container: HTMLDivElement;
let root: Root | undefined;
let queryClient: QueryClient;
const onSignedOut = vi.fn();
const onSent = vi.fn();

async function render() {
  root ??= createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ReplyComposer, { email: inbound, session, onSignedOut, onSent }),
      ),
    );
  });
}
/** React Query notifies through a setTimeout(0): wait one macrotask for the mutation to settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function textarea() {
  return container.querySelector('textarea')!;
}
function ccField() {
  const label = [...container.querySelectorAll('label')].find(
    (candidate) => candidate.textContent === 'Cc',
  )!;
  return container.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`)!;
}
async function typeCc(value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(ccField(), value);
    ccField().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function button(name: string) {
  return [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(name),
  );
}
async function type(value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setValue.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(name: string) {
  const target = button(name);
  if (!target) throw new Error(`no button "${name}"`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onSignedOut.mockReset();
  onSent.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('newestInboundEmail', () => {
  it('picks the last inbox mail of an oldest-first thread, skipping our own sent mails', () => {
    const older = email('00000000-0000-4000-8000-000000000010', 'inbox');
    const ours = email('00000000-0000-4000-8000-000000000012', 'sent');
    expect(newestInboundEmail([older, inbound, ours])).toBe(inbound);
    expect(newestInboundEmail([ours])).toBeUndefined();
    expect(newestInboundEmail([])).toBeUndefined();
  });
});

describe('ReplyComposer', () => {
  it('sends the trimmed text under a minted id, freezes it once sent, and starts another under a new id', async () => {
    const sendReply = answerSends('sent', 'sent');
    await render();
    await type('  Dear Ravi  ');
    await click('Send reply');

    expect(sendReply).toHaveBeenCalledTimes(1);
    const [, emailId, firstBody] = sendReply.mock.calls[0]!;
    expect(emailId).toBe(inbound.id);
    expect(firstBody).toEqual({ sentMailId: expect.any(String), text: 'Dear Ravi' });
    expect(container.textContent).toContain('Reply sent to ravi@example.com.');
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
    expect(textarea().disabled).toBe(true);
    expect(button('Send reply')).toBeUndefined();

    await click('Write another reply');
    expect(textarea().disabled).toBe(false);
    expect(textarea().value).toBe('');
    await type('Second');
    await click('Send reply');
    const [, , secondBody] = sendReply.mock.calls[1]!;
    expect(secondBody.sentMailId).not.toBe(firstBody.sentMailId);
  });

  it('copies the Cc addresses in, refusing a bad one before anything is sent', async () => {
    const sendReply = answerSends('sent');
    await render();
    await type('Dear Ravi');
    await typeCc('priya@example.com, vikram.example.com');
    await click('Send reply');
    expect(sendReply).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      '"vikram.example.com" is not an email address.',
    );
    expect(ccField().getAttribute('aria-invalid')).toBe('true');

    await typeCc('priya@example.com, Vikram Joshi <vikram@example.com>');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click('Send reply');
    const [, , body] = sendReply.mock.calls[0]!;
    expect(body.cc).toEqual([
      { name: '', address: 'priya@example.com' },
      { name: 'Vikram Joshi', address: 'vikram@example.com' },
    ]);
    expect(container.textContent).toContain(
      'Reply sent to ravi@example.com, cc priya@example.com, vikram@example.com.',
    );
    expect(ccField().disabled).toBe(true);
  });

  it('asks for text instead of sending an empty reply', async () => {
    const sendReply = answerSends();
    await render();
    await click('Send reply');
    expect(sendReply).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Write the reply before sending.');
    expect(textarea().getAttribute('aria-invalid')).toBe('true');
  });

  it('shows why Gmail refused a send and retries under a new id with the text still editable', async () => {
    const sendReply = answerSends('failed', 'sent');
    await render();
    await type('Dear Ravi');
    await click('Send reply');
    expect(container.textContent).toContain(
      'Reply not sent. Gmail rejected the message. Check the address and the text.',
    );
    expect(textarea().disabled).toBe(false);
    // Nothing went out, so the conversation has nothing to wait for.
    expect(onSent).not.toHaveBeenCalled();

    await type('Dear Ravi, corrected');
    await click('Try again');
    const [, , firstBody] = sendReply.mock.calls[0]!;
    const [, , secondBody] = sendReply.mock.calls[1]!;
    expect(secondBody.text).toBe('Dear Ravi, corrected');
    expect(secondBody.sentMailId).not.toBe(firstBody.sentMailId);
    expect(container.textContent).toContain('Reply sent to ravi@example.com.');
  });

  it('retries a send that never answered under the SAME id, so Gmail can never get it twice', async () => {
    const sendReply = answerSends(new TypeError('Failed to fetch'), 'sent');
    await render();
    await type('Dear Ravi');
    await click('Send reply');
    expect(container.textContent).toContain('Reply not sent.');
    expect(container.textContent).toContain('Trying again is safe');

    await click('Try again');
    const [, , firstBody] = sendReply.mock.calls[0]!;
    const [, , secondBody] = sendReply.mock.calls[1]!;
    expect(secondBody.sentMailId).toBe(firstBody.sentMailId);
    expect(container.textContent).toContain('Reply sent to ravi@example.com.');
  });

  it('mints a new id after sent_mail_id_taken and signs out on a 401', async () => {
    const sendReply = answerSends(new FrontendApiError(409, 'sent_mail_id_taken'), 'sent');
    await render();
    await type('Dear Ravi');
    await click('Send reply');
    expect(container.textContent).toContain('This reply could not be started. Press Send again.');
    await click('Try again');
    const [, , firstBody] = sendReply.mock.calls[0]!;
    const [, , secondBody] = sendReply.mock.calls[1]!;
    expect(secondBody.sentMailId).not.toBe(firstBody.sentMailId);

    await click('Write another reply');
    answerSends(new FrontendApiError(401, 'unauthenticated'));
    await type('Again');
    await click('Send reply');
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('puts the copilot proposal into the message, ready to edit and send', async () => {
    vi.useFakeTimers();
    const running: AgentRunResponse = {
      id: '00000000-0000-4000-8000-000000000031',
      emailId: inbound.id,
      gmailThreadId: 'abc123',
      instruction: 'draft a reply',
      status: 'running',
      proposal: null,
      toolCalls: [],
      model: 'gpt-6.1-sol',
      promptVersion: 'propose-reply-v1',
      usage: { inputTokens: 0, outputTokens: 0 },
      errorCode: null,
      createdAt: '2026-11-22T10:00:00.000Z',
      finishedAt: null,
    };
    vi.spyOn(frontendApi, 'createAgentRun').mockResolvedValueOnce(running);
    vi.spyOn(frontendApi, 'agentRun').mockResolvedValueOnce({
      ...running,
      status: 'proposed',
      proposal: {
        subject: 'Re: Rates',
        bodyText: 'Dear Ravi,\n\nNoted.',
        citedGmailMessageIds: [],
        citedMessages: [],
      },
      finishedAt: '2026-11-22T10:00:20.000Z',
    });
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    try {
      root ??= createRoot(container);
      await act(async () => {
        root!.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(ReplyComposer, { email: inbound, session, onSignedOut }),
          ),
        );
      });
      await type('my own start');
      await act(async () => {
        button('Ask the copilot')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await advance(AGENT_RUN_POLL_MS + 1);
      await act(async () => {
        button('Use this reply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await advance(1);
      expect(textarea().value).toBe('Dear Ravi,\n\nNoted.');
      expect(document.activeElement).toBe(textarea());
    } finally {
      vi.useRealTimers();
    }
  });

  it('freezes a reply Gmail may have taken and lets the operator check on it with the same id', async () => {
    const sendReply = answerSends('sending', 'sent');
    await render();
    await type('Dear Ravi');
    await click('Send reply');
    expect(container.textContent).toContain('Handed to Gmail; waiting for it to confirm.');
    expect(textarea().disabled).toBe(true);

    await click('Check status');
    const [, , firstBody] = sendReply.mock.calls[0]!;
    const [, , secondBody] = sendReply.mock.calls[1]!;
    expect(secondBody).toEqual(firstBody);
    expect(container.textContent).toContain('Reply sent to ravi@example.com.');
    expect(button('Check status')).toBeUndefined();
  });
});
