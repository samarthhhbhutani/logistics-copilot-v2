import { describe, expect, it } from 'vitest';
import { fromJsonProposal, fromJsonToolCalls } from './agentRunModels.js';

describe('fromJsonProposal', () => {
  it('reads back what the loop wrote and treats anything else as no proposal', () => {
    const proposal = {
      subject: 'Re: Rotterdam',
      bodyText: 'Hi Priya',
      citedGmailMessageIds: ['m-1'],
    };
    expect(fromJsonProposal(proposal)).toEqual(proposal);
    expect(fromJsonProposal(null)).toBeNull();
    expect(fromJsonProposal({ subject: 'x' })).toBeNull();
    expect(fromJsonProposal('Hi Priya')).toBeNull();
  });
});

describe('fromJsonToolCalls', () => {
  it('keeps well-formed entries in order and drops malformed ones instead of failing the read', () => {
    const good = {
      name: 'get_thread',
      arguments: '{"gmailThreadId":"t"}',
      outcome: 'ok',
      durationMs: 120,
    };
    expect(fromJsonToolCalls([good, { name: 'x' }, 'junk', { ...good, durationMs: -1 }])).toEqual([
      good,
    ]);
    expect(fromJsonToolCalls(null)).toEqual([]);
    expect(fromJsonToolCalls({})).toEqual([]);
  });
});
