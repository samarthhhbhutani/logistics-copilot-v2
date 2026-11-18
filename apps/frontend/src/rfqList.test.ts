import { describe, expect, it } from 'vitest';
import type { RfqCustomerMailGroupResponse, RfqListItemResponse } from '@lc/contract';
import { formatRoute, mergeCustomerMailPages, rfqProgressPill } from './rfqList.js';

function item(
  id: string,
  replies: RfqListItemResponse['replies'],
  status: 'open' | 'closed' = 'open',
): RfqListItemResponse {
  return {
    rfq: {
      id,
      sourceEmailId: '00000000-0000-4000-8000-000000000001',
      originPort: 'Hazira',
      destinationPort: 'Jebel Ali',
      incoterm: 'FOB',
      status,
      createdAt: '2026-11-16T07:00:00.000Z',
      updatedAt: '2026-11-16T07:00:00.000Z',
    },
    replies,
  };
}

function group(emailId: string, rfqs: RfqListItemResponse[]): RfqCustomerMailGroupResponse {
  return {
    sourceEmail: {
      id: emailId,
      sender: { name: 'Ravi', email: 'ravi@acme.example' },
      subject: 'RFQ',
      receivedAt: '2026-11-15T09:00:00.000Z',
    },
    rfqs,
  };
}

const none = { contactCount: 3, repliedCount: 0, quoteCount: 0 };

describe('mergeCustomerMailPages', () => {
  it('appends the RFQs of a customer mail that straddles two pages to its first group, keeping page order', () => {
    const mailA = '00000000-0000-4000-8000-00000000000a';
    const mailB = '00000000-0000-4000-8000-00000000000b';
    const merged = mergeCustomerMailPages([
      {
        customerMails: [group(mailA, [item('rfq-3', none)]), group(mailB, [item('rfq-2', none)])],
        nextCursor: 'c',
      },
      { customerMails: [group(mailA, [item('rfq-1', none)])], nextCursor: null },
    ]);
    expect(
      merged.map((merged) => [merged.sourceEmail.id, merged.rfqs.map((entry) => entry.rfq.id)]),
    ).toEqual([
      [mailA, ['rfq-3', 'rfq-1']],
      [mailB, ['rfq-2']],
    ]);
  });

  it('is empty for no pages', () => {
    expect(mergeCustomerMailPages([])).toEqual([]);
  });
});

describe('rfqProgressPill', () => {
  it('reads the counts in vendors and lets a closed RFQ say only that', () => {
    expect(rfqProgressPill(item('r', none))).toEqual({
      tone: 'waiting',
      label: 'Awaiting replies',
    });
    expect(rfqProgressPill(item('r', { contactCount: 7, repliedCount: 2, quoteCount: 0 }))).toEqual(
      {
        tone: 'replied',
        label: '2 of 7 replied',
      },
    );
    expect(rfqProgressPill(item('r', { contactCount: 7, repliedCount: 2, quoteCount: 1 }))).toEqual(
      {
        tone: 'quoted',
        label: '1 quote · 2 of 7 replied',
      },
    );
    expect(rfqProgressPill(item('r', { contactCount: 3, repliedCount: 3, quoteCount: 2 }))).toEqual(
      {
        tone: 'quoted',
        label: '2 quotes · 3 of 3 replied',
      },
    );
    expect(rfqProgressPill(item('r', { contactCount: 0, repliedCount: 0, quoteCount: 0 }))).toEqual(
      {
        tone: 'unreached',
        label: 'No mail reached a vendor',
      },
    );
    expect(
      rfqProgressPill(item('r', { contactCount: 7, repliedCount: 2, quoteCount: 1 }, 'closed')),
    ).toEqual({
      tone: 'closed',
      label: 'Closed',
    });
  });
});

describe('formatRoute', () => {
  it('joins the ports with the incoterm when there is one', () => {
    expect(formatRoute(item('r', none).rfq)).toBe('Hazira → Jebel Ali · FOB');
    expect(formatRoute({ ...item('r', none).rfq, incoterm: null })).toBe('Hazira → Jebel Ali');
  });
});
