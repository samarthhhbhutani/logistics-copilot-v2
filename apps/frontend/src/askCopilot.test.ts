// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResponse, EmailDetailResponse } from '@lc/contract';
import { frontendApi, FrontendApiError } from './frontendApi.js';
import { AskCopilot, describeAgentRunFailure } from './askCopilot.js';
import { AGENT_RUN_POLL_MS, AGENT_RUN_POLL_TIMEOUT_MS } from './useAgentRun.js';

const session = {
  tenantId: '00000000-0000-4000-8000-000000000002',
  mailboxId: '00000000-0000-4000-8000-000000000001',
};
const email: EmailDetailResponse = {
  id: '00000000-0000-4000-8000-000000000011',
  gmailThreadId: 'abc123',
  gmailLabel: 'inbox',
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
const runId = '00000000-0000-4000-8000-000000000031';
const running: AgentRunResponse = {
  id: runId,
  emailId: email.id,
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
const proposed: AgentRunResponse = {
  ...running,
  status: 'proposed',
  proposal: {
    subject: 'Re: Rates',
    bodyText: 'Dear Ravi,\n\nUSD 1,450 per 40HC.',
    citedGmailMessageIds: ['gm-1'],
  },
  finishedAt: '2026-11-22T10:00:20.000Z',
};
const failed: AgentRunResponse = {
  ...running,
  status: 'failed',
  errorCode: 'tool_budget_exhausted',
  finishedAt: '2026-11-22T10:00:20.000Z',
};

let container: HTMLDivElement;
let root: Root | undefined;
let queryClient: QueryClient;
const onSignedOut = vi.fn();
const onUseReply = vi.fn();

async function render(disabled = false) {
  root ??= createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AskCopilot, { email, session, onSignedOut, onUseReply, disabled }),
      ),
    );
  });
  await advance(1);
}
/** React Query notifies through a setTimeout(0); a zero-length advance does not reach a timer due "now". */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function button(name: string) {
  return [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(name),
  );
}
async function click(name: string) {
  const target = button(name);
  if (!target) throw new Error(`no button "${name}"`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await advance(1);
}
async function typeInstruction(value: string) {
  const input = container.querySelector('input')!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onSignedOut.mockReset();
  onUseReply.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('describeAgentRunFailure', () => {
  it('explains the known codes and names an unknown one', () => {
    expect(describeAgentRunFailure('tool_budget_exhausted')).toContain('ran out of lookups');
    expect(describeAgentRunFailure('run_crashed')).toContain('Something went wrong');
    expect(describeAgentRunFailure('odd_code')).toBe(
      'The copilot could not write a reply (odd_code).',
    );
    expect(describeAgentRunFailure(null)).toBe('The copilot could not write a reply.');
  });
});

describe('AskCopilot', () => {
  it('starts a run for the thread, waits one interval before the first poll, shows the proposal and hands it over', async () => {
    const createAgentRun = vi.spyOn(frontendApi, 'createAgentRun').mockResolvedValueOnce(running);
    const agentRun = vi.spyOn(frontendApi, 'agentRun').mockResolvedValueOnce(proposed);
    await render();

    await click('Ask the copilot');
    expect(createAgentRun).toHaveBeenCalledWith(session, { gmailThreadId: 'abc123' });
    expect(button('Working… 0s')).toBeDefined();
    expect(container.textContent).toContain('Reading the conversation and our earlier mail');
    expect(agentRun).not.toHaveBeenCalled();

    await advance(1_000);
    expect(button('Working… 1s')).toBeDefined();
    await advance(AGENT_RUN_POLL_MS);
    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(container.querySelector('pre')?.textContent).toBe('Dear Ravi,\n\nUSD 1,450 per 40HC.');
    expect(button('Ask again')).toBeDefined();

    await click('Use this reply');
    expect(onUseReply).toHaveBeenCalledWith('Dear Ravi,\n\nUSD 1,450 per 40HC.');
    expect(button('Use this reply')).toBeUndefined();
    expect(container.textContent).toContain('In the message below; edit it before sending.');
  });

  it('sends the trimmed instruction when one is given, on Enter as well as on the button', async () => {
    const createAgentRun = vi.spyOn(frontendApi, 'createAgentRun').mockResolvedValue(running);
    vi.spyOn(frontendApi, 'agentRun').mockResolvedValue(running);
    await render();
    await typeInstruction('  keep it to two lines  ');
    await act(async () => {
      container
        .querySelector('input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await advance(1);
    expect(createAgentRun).toHaveBeenCalledWith(session, {
      gmailThreadId: 'abc123',
      instruction: 'keep it to two lines',
    });
    expect(container.querySelector('input')?.disabled).toBe(true);
  });

  it('explains a failed run and lets the operator ask again, dropping the old outcome', async () => {
    const createAgentRun = vi
      .spyOn(frontendApi, 'createAgentRun')
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ ...running, id: '00000000-0000-4000-8000-000000000032' });
    vi.spyOn(frontendApi, 'agentRun').mockResolvedValueOnce(failed);
    await render();
    await click('Ask the copilot');
    await advance(AGENT_RUN_POLL_MS);
    expect(container.textContent).toContain(
      'No reply proposed. The copilot ran out of lookups before it could write the reply.',
    );

    await click('Ask again');
    expect(createAgentRun).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('No reply proposed.');
    expect(button('Working… 0s')).toBeDefined();
  });

  it('shows a refused start in the operator words and signs out on a 401', async () => {
    vi.spyOn(frontendApi, 'createAgentRun')
      .mockRejectedValueOnce(new FrontendApiError(503, 'agent_unavailable'))
      .mockRejectedValueOnce(new FrontendApiError(401, 'unauthenticated'));
    await render();
    await click('Ask the copilot');
    expect(container.textContent).toContain(
      'The copilot could not start. The copilot is not available right now.',
    );
    await click('Ask again');
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('gives up after the poll timeout and says so, while polling through a failed read before that', async () => {
    vi.spyOn(frontendApi, 'createAgentRun').mockResolvedValueOnce(running);
    const agentRun = vi
      .spyOn(frontendApi, 'agentRun')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(running);
    await render();
    await click('Ask the copilot');
    await advance(AGENT_RUN_POLL_MS);
    expect(container.textContent).toContain('the last check failed, trying again');
    await advance(AGENT_RUN_POLL_MS);
    expect(agentRun).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('the last check failed');

    await advance(AGENT_RUN_POLL_TIMEOUT_MS);
    const callsAtTimeout = agentRun.mock.calls.length;
    expect(container.textContent).toContain('Still working after 2 minutes.');
    expect(button('Ask again')).toBeDefined();
    await advance(AGENT_RUN_POLL_MS * 3);
    expect(agentRun).toHaveBeenCalledTimes(callsAtTimeout);
  });

  it('does not ask while the composer text is already with Gmail', async () => {
    const createAgentRun = vi.spyOn(frontendApi, 'createAgentRun');
    await render(true);
    await click('Ask the copilot');
    expect(createAgentRun).not.toHaveBeenCalled();
    expect(container.querySelector('input')?.disabled).toBe(true);
  });
});
