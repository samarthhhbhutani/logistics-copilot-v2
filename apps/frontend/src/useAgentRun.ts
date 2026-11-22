import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentRunResponse, SessionResponse } from '@lc/contract';
import { frontendApi } from './frontendApi.js';

/** A run takes tens of seconds; two seconds keeps the wait feeling live without hammering the API. */
export const AGENT_RUN_POLL_MS = 2_000;
/** After this the UI stops asking and tells the operator to check back; the run itself carries on. */
export const AGENT_RUN_POLL_TIMEOUT_MS = 120_000;

export function agentRunQueryKey(session: SessionResponse, runId: string | null) {
  return ['agentRun', session.tenantId, session.mailboxId, runId] as const;
}

export interface AgentRunPoll {
  run: AgentRunResponse | undefined;
  /** True while the run is `running` and the poll is still asking; a failed read does not stop it. */
  isPolling: boolean;
  /** True when the run was still `running` after AGENT_RUN_POLL_TIMEOUT_MS; polling has stopped. */
  timedOut: boolean;
  /** The last read's failure while `run` keeps the last good body; cleared by the next good read. */
  error: unknown;
}

/**
 * Follows one copilot run (roadmap 6.3): reads it every AGENT_RUN_POLL_MS while it is `running`,
 * stops at `proposed` / `failed`, or gives up after AGENT_RUN_POLL_TIMEOUT_MS. `runId` null means
 * nothing to follow. Seed the cache with the 202 body (agentRunQueryKey) so the first poll waits
 * its interval rather than firing at once.
 */
export function useAgentRun(session: SessionResponse, runId: string | null): AgentRunPoll {
  // State, not a clock read: a run that stays `running` returns equal data, so nothing else would
  // re-render the component when the deadline passes.
  const [timedOutRunId, setTimedOutRunId] = useState<string | null>(null);
  useEffect(() => {
    if (runId === null) return;
    const deadline = setTimeout(() => setTimedOutRunId(runId), AGENT_RUN_POLL_TIMEOUT_MS);
    return () => clearTimeout(deadline);
  }, [runId]);
  const pastDeadline = runId !== null && timedOutRunId === runId;

  const query = useQuery({
    queryKey: agentRunQueryKey(session, runId),
    queryFn: ({ signal }) => frontendApi.agentRun(session, runId!, signal),
    enabled: runId !== null,
    // A body seeded moments ago (the 202) is fresh enough: the first read waits one interval.
    staleTime: AGENT_RUN_POLL_MS,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.status === 'running' && !pastDeadline ? AGENT_RUN_POLL_MS : false,
  });
  const running = query.data?.status === 'running';
  const timedOut = running && pastDeadline;
  return {
    run: query.data,
    // Same condition as refetchInterval: a transient failure keeps both polling and this flag.
    isPolling: running && !timedOut,
    timedOut,
    error: query.error,
  };
}
