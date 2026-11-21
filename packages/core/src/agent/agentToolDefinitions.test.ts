import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_NAMES,
  agentToolDefinitions,
  searchGmailArguments,
} from './agentToolDefinitions.js';
import { SEARCH_MAX_RESULTS } from './agentMailTools.js';

interface FunctionToolShape {
  type: string;
  name: string;
  strict?: boolean | null;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
}

describe('agentToolDefinitions', () => {
  it('defines exactly the three read-only tools, in the order the names constant lists them', () => {
    expect(agentToolDefinitions.map((tool) => (tool as FunctionToolShape).name)).toEqual([
      ...AGENT_TOOL_NAMES,
    ]);
  });

  it('is strict-mode safe: every property required, no extras, a description on each tool and argument', () => {
    for (const tool of agentToolDefinitions as FunctionToolShape[]) {
      expect(tool.type).toBe('function');
      expect(tool.strict).toBe(true);
      expect(tool.description).toMatch(/\S/);
      const parameters = tool.parameters as {
        properties: Record<string, { description?: string }>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(parameters.additionalProperties).toBe(false);
      expect([...parameters.required].sort()).toEqual(Object.keys(parameters.properties).sort());
      for (const [name, property] of Object.entries(parameters.properties)) {
        expect(property.description, `${tool.name}.${name}`).toMatch(/\S/);
      }
    }
  });

  it('search_gmail takes null for the default page size and refuses sizes past the tool ceiling', () => {
    expect(searchGmailArguments.parse({ query: 'from:a', maxResults: null })).toEqual({
      query: 'from:a',
      maxResults: null,
    });
    expect(
      searchGmailArguments.safeParse({ query: 'from:a', maxResults: SEARCH_MAX_RESULTS + 1 })
        .success,
    ).toBe(false);
    expect(searchGmailArguments.safeParse({ query: '', maxResults: null }).success).toBe(false);
    expect(searchGmailArguments.safeParse({ query: 'from:a' }).success).toBe(false);
  });
});
