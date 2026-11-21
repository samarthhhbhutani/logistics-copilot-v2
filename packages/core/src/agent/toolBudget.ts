/** Roadmap 6.1: a run may make this many tool calls before the loop must answer with what it has. */
export const DEFAULT_TOOL_CALL_LIMIT = 8;

export class ToolBudgetExceededError extends Error {
  constructor(readonly limit: number) {
    super(`tool call limit of ${limit} reached`);
    this.name = 'ToolBudgetExceededError';
  }
}

export interface ToolBudget {
  /** Records one call of `toolName`; throws ToolBudgetExceededError when the limit is already spent. */
  consume(toolName: string): void;
  readonly used: number;
  readonly limit: number;
  readonly calls: readonly string[];
}

/** One budget per agent run; the tools consume it, the loop reads it for the run record. */
export function createToolBudget(limit = DEFAULT_TOOL_CALL_LIMIT): ToolBudget {
  const calls: string[] = [];
  return {
    consume(toolName) {
      if (calls.length >= limit) throw new ToolBudgetExceededError(limit);
      calls.push(toolName);
    },
    get used() {
      return calls.length;
    },
    limit,
    calls,
  };
}
