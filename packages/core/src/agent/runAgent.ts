import type OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import { GmailApiError } from '../connectors/gmail/gmailApiError.js';
import { toLlmFailureOutcome } from '../connectors/openai/openAiEmailClassifier.js';
import { runInsideSpan } from '../telemetry/runInsideSpan.js';
import type { AgentMailTools } from './agentMailTools.js';
import { agentProposalSchema } from './agentRunModels.js';
import type { AgentProposal, AgentRunUsage, AgentToolCallRecord } from './agentRunModels.js';
import { agentToolDefinitions } from './agentToolDefinitions.js';
import { createAgentToolExecutor } from './executeAgentToolCall.js';
import {
  buildProposeReplyUserMessage,
  PROPOSE_REPLY_PROMPT_VERSION,
  PROPOSE_REPLY_SYSTEM_PROMPT,
} from './prompts/proposeReplyPromptV1.js';
import type { AnchorEmailFacts } from './prompts/proposeReplyPromptV1.js';
import { ToolBudgetExceededError } from './toolBudget.js';
import type { ToolBudget } from './toolBudget.js';

/**
 * Model turns per run. Every turn but the last makes at least one tool call, so the budget already
 * bounds this; the cap is the guard against a model that keeps asking for tools it cannot have.
 */
export const AGENT_MAX_MODEL_TURNS = 10;
/** The proposal is a short reply; the rest of the output is tool-call JSON. */
const MAX_OUTPUT_TOKENS = 1500;
/** What a tool call past the budget is answered with, so the model stops asking and writes. */
export const TOOL_BUDGET_EXHAUSTED_CODE = 'tool_budget_exhausted';

export interface RunAgentInput {
  gmailThreadId: string;
  anchor: AnchorEmailFacts;
  instruction: string;
}

export interface RunAgentDependencies {
  openAiClient: OpenAI;
  model: string;
  /** Created with the same `budget`: the tools spend it, the loop reads it to stop asking the model for more. */
  tools: AgentMailTools;
  budget: ToolBudget;
  /** Injected for the duration of tool calls in tests. */
  now?: () => number;
}

interface RunAgentTrace {
  toolCalls: AgentToolCallRecord[];
  usage: AgentRunUsage;
  /** The model that actually answered, when the API said; the requested one otherwise. */
  model: string;
  promptVersion: string;
}

export type RunAgentResult =
  | ({ outcome: 'proposed'; proposal: AgentProposal } & RunAgentTrace)
  /**
   * errorCode: `llm_retry` / `llm_failed` (provider), a GmailApiError code, `incomplete_output`,
   * `no_proposal` (final turn had no parsable proposal) or `turn_limit`. detail is for the log.
   */
  | ({ outcome: 'failed'; errorCode: string; detail: string } & RunAgentTrace);

/**
 * One copilot run (roadmap 6.2): the Responses API loop around the agent's read-only tools. The
 * conversation lives on the provider side: every turn after the first names the previous response
 * (`previous_response_id`) and sends only the new tool outputs, so the model keeps its own reasoning
 * between turns and the requests stay small (decision 11-22; OpenAI holds the stored responses for
 * its retention window). Ends on the first turn without a tool call, whose message must parse as an
 * AgentProposal. Never sends anything.
 */
export async function runAgent(
  input: RunAgentInput,
  { openAiClient, model, tools, budget, now = Date.now }: RunAgentDependencies,
): Promise<RunAgentResult> {
  const executor = createAgentToolExecutor(tools);
  const toolCalls: AgentToolCallRecord[] = [];
  const usage: AgentRunUsage = { inputTokens: 0, outputTokens: 0 };
  let answeredBy = model;
  const trace = (): RunAgentTrace => ({
    toolCalls,
    usage,
    model: answeredBy,
    promptVersion: PROPOSE_REPLY_PROMPT_VERSION,
  });
  const failed = (errorCode: string, detail: string): RunAgentResult => ({
    outcome: 'failed',
    errorCode,
    detail,
    ...trace(),
  });

  // What the next turn sends: the operator's ask first, then only the tool outputs of the last turn.
  let pendingInput: ResponseInputItem[] = [
    { role: 'user', content: buildProposeReplyUserMessage(input) },
  ];
  let previousResponseId: string | undefined;

  return runInsideSpan(
    'agent.run',
    async (span) => {
      for (let turn = 0; turn < AGENT_MAX_MODEL_TURNS; turn++) {
        const budgetSpent = budget.used >= budget.limit;
        let response;
        try {
          response = await runInsideSpan('agent.model_turn', () =>
            openAiClient.responses.parse({
              model,
              // Instructions are per request, not inherited through previous_response_id.
              instructions: PROPOSE_REPLY_SYSTEM_PROMPT,
              input: pendingInput,
              previous_response_id: previousResponseId,
              tools: agentToolDefinitions,
              // Once the budget is spent the model is told to write with what it has.
              tool_choice: budgetSpent ? 'none' : 'auto',
              text: { format: zodTextFormat(agentProposalSchema, 'reply_proposal') },
              max_output_tokens: MAX_OUTPUT_TOKENS,
              store: true,
            }),
          );
        } catch (error) {
          const failure = toLlmFailureOutcome(error);
          return failed(failure.outcome === 'retry' ? 'llm_retry' : 'llm_failed', failure.detail);
        }
        previousResponseId = response.id;
        pendingInput = [];
        if (response.model) answeredBy = response.model;
        usage.inputTokens += response.usage?.input_tokens ?? 0;
        usage.outputTokens += response.usage?.output_tokens ?? 0;
        span.setAttributes({
          'agent.turns': turn + 1,
          'llm.input_tokens': usage.inputTokens,
          'llm.output_tokens': usage.outputTokens,
        });

        if (response.incomplete_details) {
          return failed('incomplete_output', response.incomplete_details.reason ?? 'incomplete');
        }
        const functionCalls = response.output.filter((item) => item.type === 'function_call');
        if (functionCalls.length === 0) {
          const proposal = agentProposalSchema.safeParse(response.output_parsed);
          if (!proposal.success) {
            return failed('no_proposal', 'the final turn carried no parsable proposal');
          }
          span.setAttributes({ 'agent.tool_calls': toolCalls.length });
          return { outcome: 'proposed', proposal: proposal.data, ...trace() };
        }

        for (const functionCall of functionCalls) {
          const startedAt = now();
          let output: string;
          let outcome: string;
          if (budget.used >= budget.limit) {
            // Checked here, not left to the tools, so the model is answered instead of the run dying.
            outcome = TOOL_BUDGET_EXHAUSTED_CODE;
            output = budgetExhaustedOutput();
            toolCalls.push(record(functionCall, outcome, 0));
            pendingInput.push({
              type: 'function_call_output',
              call_id: functionCall.call_id,
              output,
            });
            continue;
          }
          try {
            const result = await executor.execute({
              callId: functionCall.call_id,
              name: functionCall.name,
              arguments: functionCall.arguments,
            });
            output = result.output;
            outcome = result.toolError ?? 'ok';
          } catch (error) {
            if (error instanceof ToolBudgetExceededError) {
              // The tools count too; a race between the two checks lands here.
              outcome = TOOL_BUDGET_EXHAUSTED_CODE;
              output = budgetExhaustedOutput();
            } else {
              toolCalls.push(record(functionCall, 'threw', now() - startedAt));
              return failed(
                error instanceof GmailApiError ? error.code : 'tool_failed',
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          toolCalls.push(record(functionCall, outcome, now() - startedAt));
          pendingInput.push({
            type: 'function_call_output',
            call_id: functionCall.call_id,
            output,
          });
        }
      }
      return failed('turn_limit', `no proposal after ${AGENT_MAX_MODEL_TURNS} model turns`);
    },
    { 'llm.model': model, 'llm.prompt_version': PROPOSE_REPLY_PROMPT_VERSION },
  );
}

function budgetExhaustedOutput(): string {
  return JSON.stringify({
    error: TOOL_BUDGET_EXHAUSTED_CODE,
    message: 'no tool calls left in this run; write the reply with what you have',
  });
}

function record(
  functionCall: { name: string; arguments: string },
  outcome: string,
  durationMs: number,
): AgentToolCallRecord {
  return {
    name: functionCall.name,
    arguments: functionCall.arguments,
    outcome,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}
