import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaAgentRunRepository } from './agentRunRepository.js';

const scope = { tenantId: 'tenant-1', mailboxId: 'mailbox-1' };
const createdAt = new Date('2025-11-21T10:00:00Z');

const runningRow = {
  id: 'run-1',
  emailId: 'email-1',
  gmailThreadId: 't-rotterdam',
  instruction: 'propose a reply using vendor quotes',
  status: 'RUNNING',
  proposal: null,
  toolCalls: [],
  model: 'gpt-6.1-sol',
  promptVersion: 'proposeReply.v1',
  inputTokens: 0,
  outputTokens: 0,
  errorCode: null,
  createdAt,
  finishedAt: null,
};

/** Records every Prisma call and answers each method with the given value. */
function stubPrisma(
  answers: Partial<Record<'create' | 'findFirst' | 'findMany' | 'updateMany', unknown>>,
) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const agentRun = Object.fromEntries(
    Object.entries(answers).map(([method, answer]) => [
      method,
      async (args: Record<string, unknown>) => {
        calls.push({ method, args });
        return answer;
      },
    ]),
  );
  return { prismaClient: { agentRun } as unknown as PrismaClient, calls };
}

describe('create', () => {
  it('writes the row in the mailbox scope with status running and reads it back in API shape', async () => {
    const { prismaClient, calls } = stubPrisma({ create: runningRow });
    const run = await createPrismaAgentRunRepository(prismaClient).create(scope, {
      emailId: 'email-1',
      gmailThreadId: 't-rotterdam',
      instruction: 'propose a reply using vendor quotes',
      model: 'gpt-6.1-sol',
      promptVersion: 'proposeReply.v1',
    });
    expect(calls[0]!.method).toBe('create');
    expect(calls[0]!.args.data).toEqual({
      ...scope,
      emailId: 'email-1',
      gmailThreadId: 't-rotterdam',
      instruction: 'propose a reply using vendor quotes',
      model: 'gpt-6.1-sol',
      promptVersion: 'proposeReply.v1',
    });
    expect(run).toEqual({
      id: 'run-1',
      emailId: 'email-1',
      gmailThreadId: 't-rotterdam',
      instruction: 'propose a reply using vendor quotes',
      status: 'running',
      proposal: null,
      toolCalls: [],
      model: 'gpt-6.1-sol',
      promptVersion: 'proposeReply.v1',
      usage: { inputTokens: 0, outputTokens: 0 },
      errorCode: null,
      createdAt,
      finishedAt: null,
    });
  });
});

describe('findAgentRun and listForThread', () => {
  it('scopes every read by mailbox and tenant, and maps a proposed row with its proposal and tool calls', async () => {
    const proposal = {
      subject: 'Re: Rotterdam',
      bodyText: 'Hi Priya',
      citedGmailMessageIds: ['m-2'],
    };
    const toolCall = { name: 'get_thread', arguments: '{}', outcome: 'ok', durationMs: 80 };
    const proposedRow = {
      ...runningRow,
      status: 'PROPOSED',
      proposal,
      toolCalls: [toolCall, 'junk'],
      inputTokens: 1200,
      outputTokens: 300,
      finishedAt: new Date('2025-11-21T10:00:20Z'),
    };
    const { prismaClient, calls } = stubPrisma({ findFirst: proposedRow, findMany: [proposedRow] });
    const repository = createPrismaAgentRunRepository(prismaClient);

    const found = await repository.findAgentRun(scope, 'run-1');
    expect(calls[0]!.args.where).toEqual({ id: 'run-1', ...scope });
    expect(found).toMatchObject({
      status: 'proposed',
      proposal,
      toolCalls: [toolCall],
      usage: { inputTokens: 1200, outputTokens: 300 },
      finishedAt: new Date('2025-11-21T10:00:20Z'),
    });

    const listed = await repository.listForThread(scope, 't-rotterdam', 5);
    expect(calls[1]!.args).toMatchObject({
      where: { ...scope, gmailThreadId: 't-rotterdam' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5,
    });
    expect(listed.map((run) => run.id)).toEqual(['run-1']);
  });

  it('reports null for a run id the mailbox does not own', async () => {
    const { prismaClient } = stubPrisma({ findFirst: null });
    await expect(
      createPrismaAgentRunRepository(prismaClient).findAgentRun(scope, 'run-x'),
    ).resolves.toBeNull();
  });
});

describe('markProposed and markFailed', () => {
  const details = {
    toolCalls: [
      {
        name: 'search_gmail',
        arguments: '{"query":"q","maxResults":null}',
        outcome: 'ok',
        durationMs: 50,
      },
    ],
    usage: { inputTokens: 900, outputTokens: 120 },
  };

  it('moves only a running row of this mailbox to proposed, writing the proposal, log and usage', async () => {
    const { prismaClient, calls } = stubPrisma({ updateMany: { count: 1 } });
    const proposal = { subject: 'Re: x', bodyText: 'body', citedGmailMessageIds: [] };
    const result = await createPrismaAgentRunRepository(prismaClient).markProposed(scope, 'run-1', {
      ...details,
      proposal,
    });
    expect(result).toEqual({ moved: true });
    expect(calls[0]!.args.where).toEqual({ id: 'run-1', ...scope, status: 'RUNNING' });
    expect(calls[0]!.args.data).toMatchObject({
      status: 'PROPOSED',
      proposal,
      toolCalls: details.toolCalls,
      inputTokens: 900,
      outputTokens: 120,
      errorCode: null,
    });
    expect((calls[0]!.args.data as { finishedAt: Date }).finishedAt).toBeInstanceOf(Date);
  });

  it('moves a running row to failed with the error code, and reports no move when the row is not running', async () => {
    const moved = stubPrisma({ updateMany: { count: 1 } });
    const result = await createPrismaAgentRunRepository(moved.prismaClient).markFailed(
      scope,
      'run-1',
      {
        ...details,
        errorCode: 'tool_budget_exhausted',
      },
    );
    expect(result).toEqual({ moved: true });
    expect(moved.calls[0]!.args.data).toMatchObject({
      status: 'FAILED',
      errorCode: 'tool_budget_exhausted',
    });

    const alreadyFinished = stubPrisma({ updateMany: { count: 0 } });
    await expect(
      createPrismaAgentRunRepository(alreadyFinished.prismaClient).markFailed(scope, 'run-1', {
        ...details,
        errorCode: 'rate_limited',
      }),
    ).resolves.toEqual({ moved: false });
  });
});
