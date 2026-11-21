import { GmailApiError } from '../connectors/gmail/gmailApiError.js';
import type { AgentMailTools } from './agentMailTools.js';
import {
  getMessageArguments,
  getThreadArguments,
  searchGmailArguments,
} from './agentToolDefinitions.js';

/** The part of a Responses API `function_call` item the executor needs. */
export interface AgentToolCall {
  callId: string;
  name: string;
  /** The model's JSON string, unparsed: the executor validates it, not the loop. */
  arguments: string;
}

/** Becomes a `function_call_output` item: `output` is always a JSON string, success or tool error. */
export interface AgentToolCallOutput {
  callId: string;
  output: string;
  /** Set when `output` carries an error the model is expected to recover from. */
  toolError?: AgentToolErrorCode;
}

/**
 * Errors the model gets to see and act on. Anything else (auth, quota, budget exhausted, bugs) is
 * thrown to the loop, because retrying from the model's side cannot fix it.
 */
export type AgentToolErrorCode = 'unknown_tool' | 'invalid_arguments' | 'not_found';

export interface AgentToolExecutor {
  execute(call: AgentToolCall): Promise<AgentToolCallOutput>;
}

export function createAgentToolExecutor(tools: AgentMailTools): AgentToolExecutor {
  return {
    async execute(call) {
      const parsedJson = parseJson(call.arguments);
      if (!parsedJson.ok) {
        return toolError(
          call,
          'invalid_arguments',
          `arguments are not valid JSON: ${parsedJson.detail}`,
        );
      }
      try {
        switch (call.name) {
          case 'search_gmail': {
            const parsed = searchGmailArguments.safeParse(parsedJson.value);
            if (!parsed.success) return invalidArguments(call, parsed.error);
            const { query, maxResults } = parsed.data;
            return success(
              call,
              await tools.searchGmail(maxResults === null ? { query } : { query, maxResults }),
            );
          }
          case 'get_thread': {
            const parsed = getThreadArguments.safeParse(parsedJson.value);
            if (!parsed.success) return invalidArguments(call, parsed.error);
            return success(call, await tools.getThread(parsed.data));
          }
          case 'get_message': {
            const parsed = getMessageArguments.safeParse(parsedJson.value);
            if (!parsed.success) return invalidArguments(call, parsed.error);
            return success(call, await tools.getMessage(parsed.data));
          }
          default:
            return toolError(call, 'unknown_tool', `no tool named ${call.name}`);
        }
      } catch (error) {
        if (error instanceof GmailApiError && error.code === 'not_found') {
          return toolError(call, 'not_found', 'no such message or thread in this mailbox');
        }
        throw error;
      }
    },
  };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; detail: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function success(call: AgentToolCall, result: unknown): AgentToolCallOutput {
  return { callId: call.callId, output: JSON.stringify(result) };
}

function invalidArguments(
  call: AgentToolCall,
  zodError: { issues: { path: PropertyKey[]; message: string }[] },
): AgentToolCallOutput {
  const detail = zodError.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return toolError(call, 'invalid_arguments', detail);
}

function toolError(
  call: AgentToolCall,
  code: AgentToolErrorCode,
  message: string,
): AgentToolCallOutput {
  return { callId: call.callId, output: JSON.stringify({ error: code, message }), toolError: code };
}
