import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
import type { EmailDetailResponse, SessionResponse } from '@lc/contract';
import { MAX_AGENT_INSTRUCTION_LENGTH } from '@lc/contract';
import { errorMessage, frontendApi, isUnauthenticated } from './frontendApi.js';
import { AGENT_RUN_POLL_TIMEOUT_MS, agentRunQueryKey, useAgentRun } from './useAgentRun.js';

const FAILURE_EXPLANATIONS: Record<string, string> = {
  llm_retry: 'The model did not answer in time.',
  llm_failed: 'The model could not write this reply.',
  incomplete_output: 'The model stopped before finishing the reply.',
  no_proposal: 'The copilot did not arrive at a reply.',
  turn_limit: 'The copilot did not arrive at a reply.',
  tool_budget_exhausted: 'The copilot ran out of lookups before it could write the reply.',
  invalid_grant: 'The Gmail connection needs to be reconnected before the copilot can read mail.',
  run_crashed: 'Something went wrong while the copilot was working.',
};

/** Why a run ended `failed`, in the operator's words; the code is kept for a report. */
export function describeAgentRunFailure(errorCode: string | null): string {
  if (errorCode === null) return 'The copilot could not write a reply.';
  return FAILURE_EXPLANATIONS[errorCode] ?? `The copilot could not write a reply (${errorCode}).`;
}

/**
 * Asks the copilot for a reply to the thread (roadmap 6.3) and hands the proposal to the reply
 * composer through `onUseReply`; nothing is sent from here. The 202 body seeds the run cache so the
 * first poll waits its interval, and `useAgentRun` follows the run until it is proposed, failed or
 * AGENT_RUN_POLL_TIMEOUT_MS has passed.
 */
export function AskCopilot({
  email,
  session,
  onSignedOut,
  onUseReply,
  disabled,
}: {
  /** The inbound mail the reply answers; its thread is what the copilot reads. */
  email: EmailDetailResponse;
  session: SessionResponse;
  onSignedOut: () => void;
  onUseReply: (bodyText: string) => void;
  /** True while the composer's text is already with Gmail: a new proposal would have nowhere to go. */
  disabled: boolean;
}) {
  const instructionId = useId();
  // One outcome shows at a time, so the paragraphs and the proposal section share the focus target.
  const outcomeLine = useRef<HTMLElement>(null);
  const focusOutcome = (element: HTMLElement | null) => {
    outcomeLine.current = element;
  };
  const queryClient = useQueryClient();
  const [instruction, setInstruction] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [usedRunId, setUsedRunId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      frontendApi.createAgentRun(session, {
        gmailThreadId: email.gmailThreadId,
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
      }),
    onSuccess: (run) => {
      queryClient.setQueryData(agentRunQueryKey(session, run.id), run);
      setRunId(run.id);
    },
    retry: false,
  });
  const poll = useAgentRun(session, runId);
  const run = poll.run;
  const expired = isUnauthenticated(start.error) || isUnauthenticated(poll.error);
  useEffect(() => {
    if (expired) onSignedOut();
  }, [expired, onSignedOut]);

  // Seconds since the ask, so a wait of tens of seconds visibly moves.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    setElapsedSeconds(0);
    if (runId === null) return;
    const ticker = setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1_000);
    return () => clearInterval(ticker);
  }, [runId]);

  const busy = start.isPending || poll.isPolling;
  const settled = run?.status === 'proposed' || run?.status === 'failed' || poll.timedOut;
  const outcomeShown = settled || (start.isError && !expired);
  // The outcome replaces the button the operator pressed: read it out and move focus to it.
  useEffect(() => {
    if (outcomeShown) outcomeLine.current?.focus();
  }, [outcomeShown, runId]);

  function ask() {
    if (busy || disabled) return;
    // The earlier outcome leaves with the new ask; a refused start then stands alone.
    setRunId(null);
    setUsedRunId(null);
    start.mutate();
  }

  const proposal = run?.status === 'proposed' ? run.proposal : null;
  const buttonLabel = start.isPending
    ? 'Asking…'
    : poll.isPolling
      ? `Working… ${elapsedSeconds}s`
      : runId !== null || start.isError
        ? 'Ask again'
        : 'Ask the copilot';

  return (
    <div className="askCopilot">
      <div className="askCopilotAsk">
        <label htmlFor={instructionId}>Ask the copilot</label>
        <p className="muted">
          Left empty, it writes in the format of our earlier mail to this sender and, for a shipment
          request, copies the costs of our earlier quote for a similar one.
        </p>
        <div className="askCopilotRow">
          <input
            id={instructionId}
            type="text"
            maxLength={MAX_AGENT_INSTRUCTION_LENGTH}
            placeholder="Anything the reply should say (optional)"
            value={instruction}
            disabled={busy || disabled}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                ask();
              }
            }}
          />
          <button className="button secondary" aria-disabled={busy || disabled} onClick={ask}>
            {busy ? (
              <RefreshCw size={16} aria-hidden="true" className="spinning" />
            ) : (
              <Sparkles size={16} aria-hidden="true" />
            )}
            {buttonLabel}
          </button>
        </div>
      </div>
      {poll.isPolling && (
        <p className="copilotOutcome" role="status">
          Reading the conversation and our earlier mail
          {poll.error ? '; the last check failed, trying again' : ''}…
        </p>
      )}
      {start.isError && !expired && (
        <p className="inlineAlert" role="alert" ref={focusOutcome} tabIndex={-1}>
          <TriangleAlert size={16} aria-hidden="true" />
          The copilot could not start. {errorMessage(start.error)}
        </p>
      )}
      {poll.timedOut && (
        <p className="copilotOutcome" role="status" ref={focusOutcome} tabIndex={-1}>
          Still working after {AGENT_RUN_POLL_TIMEOUT_MS / 60_000} minutes. Ask again in a moment,
          or write the reply by hand.
        </p>
      )}
      {run?.status === 'failed' && (
        <p className="inlineAlert" role="alert" ref={focusOutcome} tabIndex={-1}>
          <TriangleAlert size={16} aria-hidden="true" />
          No reply proposed. {describeAgentRunFailure(run.errorCode)}
        </p>
      )}
      {proposal && run && (
        <section
          className="copilotProposal"
          aria-label="Proposed reply"
          ref={focusOutcome}
          tabIndex={-1}
        >
          <p className="eyebrow">Proposed reply</p>
          <pre>{proposal.bodyText}</pre>
          <div className="replyComposerActions">
            {usedRunId === run.id ? (
              <p className="copilotOutcome" role="status">
                <Check size={16} aria-hidden="true" />
                In the message below; edit it before sending.
              </p>
            ) : (
              <button
                className="button"
                aria-disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onUseReply(proposal.bodyText);
                  setUsedRunId(run.id);
                }}
              >
                Use this reply
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
