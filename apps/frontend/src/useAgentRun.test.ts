// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResponse } from '@lc/contract';
import { frontendApi } from './frontendApi.js';
import {
  AGENT_RUN_POLL_MS,
  AGENT_RUN_POLL_TIMEOUT_MS,
  agentRunQueryKey,
  useAgentRun,
} from './useAgentRun.js';
import type { AgentRunPoll } from './useAgentRun.js';

const session = {
  tenantId: '00000000-0000-4000-8000-000000000002',
  mailboxId: '00000000-0000-4000-8000-000000000001',
};
const runId = '00000000-0000-4000-8000-000000000031';
const running: AgentRunResponse = {
  id: runId,
  emailId: '00000000-0000-4000-8000-000000000011',
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
    subject: 'Re: hi',
    bodyText: 'Dear Ravi,',
    citedGmailMessageIds: ['gm-1'],
    citedMessages: [],
  },
  finishedAt: '2026-11-22T10:00:20.000Z',
};

let container: HTMLDivElement;
let root: Root | undefined;
let queryClient: QueryClient;
let latest: AgentRunPoll | undefined;

function Probe({ runId: followed }: { runId: string | null }) {
  latest = useAgentRun(session, followed);
  return null;
}

/** React Query notifies through a setTimeout(0); a zero-length advance does not reach a timer due "now". */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

async function render(followed: string | null) {
  root ??= createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Probe, { runId: followed }),
      ),
    );
  });
  await flush();
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  latest = undefined;
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

describe('useAgentRun', () => {
  it('polls every AGENT_RUN_POLL_MS from the seeded 202 body until the run is proposed, then stops', async () => {
    const agentRun = vi
      .spyOn(frontendApi, 'agentRun')
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(proposed);
    queryClient.setQueryData(agentRunQueryKey(session, runId), running);

    await render(runId);
    expect(latest).toMatchObject({ run: running, isPolling: true, timedOut: false });
    expect(agentRun).not.toHaveBeenCalled();

    await advance(AGENT_RUN_POLL_MS);
    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(agentRun).toHaveBeenLastCalledWith(session, runId, expect.any(AbortSignal));
    expect(latest?.isPolling).toBe(true);

    await advance(AGENT_RUN_POLL_MS);
    expect(agentRun).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ run: proposed, isPolling: false, timedOut: false });

    await advance(AGENT_RUN_POLL_MS * 5);
    expect(agentRun).toHaveBeenCalledTimes(2);
  });

  it('gives up after AGENT_RUN_POLL_TIMEOUT_MS while the run is still running', async () => {
    const agentRun = vi.spyOn(frontendApi, 'agentRun').mockResolvedValue(running);
    queryClient.setQueryData(agentRunQueryKey(session, runId), running);
    await render(runId);

    await advance(AGENT_RUN_POLL_TIMEOUT_MS - AGENT_RUN_POLL_MS);
    expect(latest?.timedOut).toBe(false);
    expect(latest?.isPolling).toBe(true);
    const callsBeforeTimeout = agentRun.mock.calls.length;
    expect(callsBeforeTimeout).toBeGreaterThan(50);

    await advance(AGENT_RUN_POLL_MS);
    expect(latest).toMatchObject({ run: running, isPolling: false, timedOut: true });
    const callsAtTimeout = agentRun.mock.calls.length;

    await advance(AGENT_RUN_POLL_MS * 5);
    expect(agentRun.mock.calls.length).toBe(callsAtTimeout);
  });

  it('fetches at once when nothing is seeded, reports a failed read, and follows nothing for a null id', async () => {
    const agentRun = vi.spyOn(frontendApi, 'agentRun').mockRejectedValueOnce(new Error('offline'));
    await render(null);
    expect(latest).toMatchObject({ run: undefined, isPolling: false, timedOut: false });
    expect(agentRun).not.toHaveBeenCalled();

    await render(runId);
    await flush();
    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(latest?.error).toBeInstanceOf(Error);
    expect(latest?.isPolling).toBe(false);
  });

  it('keeps polling through a failed read of a running run, exposing the error until the next good read', async () => {
    const agentRun = vi
      .spyOn(frontendApi, 'agentRun')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(proposed);
    queryClient.setQueryData(agentRunQueryKey(session, runId), running);
    await render(runId);

    await advance(AGENT_RUN_POLL_MS);
    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({ run: running, isPolling: true, timedOut: false });
    expect(latest?.error).toBeInstanceOf(Error);

    await advance(AGENT_RUN_POLL_MS);
    expect(agentRun).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ run: proposed, isPolling: false, error: null });
  });
});
