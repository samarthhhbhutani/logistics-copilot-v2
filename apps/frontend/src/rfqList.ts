import type {
  ListRfqsResponse,
  RfqCustomerMailGroupResponse,
  RfqListItemResponse,
} from '@lc/contract';

/**
 * The groups of every loaded page, in page order. The API cuts pages in RFQs, not groups, so a
 * customer mail whose RFQs straddle a page boundary comes back once per page; here its RFQs are
 * appended to the group that already exists (the API already orders them newest first).
 */
export function mergeCustomerMailPages(pages: ListRfqsResponse[]): RfqCustomerMailGroupResponse[] {
  const groupBySourceEmailId = new Map<string, RfqCustomerMailGroupResponse>();
  for (const page of pages) {
    for (const group of page.customerMails) {
      const existing = groupBySourceEmailId.get(group.sourceEmail.id);
      if (existing) {
        groupBySourceEmailId.set(group.sourceEmail.id, {
          ...existing,
          rfqs: [...existing.rfqs, ...group.rfqs],
        });
      } else {
        groupBySourceEmailId.set(group.sourceEmail.id, group);
      }
    }
  }
  return [...groupBySourceEmailId.values()];
}

export type RfqProgressTone = 'closed' | 'unreached' | 'waiting' | 'replied' | 'quoted';

export interface RfqProgressPill {
  tone: RfqProgressTone;
  label: string;
}

/** The one line on a card that says where an RFQ stands, counted in vendors. */
export function rfqProgressPill({ rfq, replies }: RfqListItemResponse): RfqProgressPill {
  if (rfq.status === 'closed') return { tone: 'closed', label: 'Closed' };
  const { contactCount, repliedCount, quoteCount } = replies;
  if (contactCount === 0) return { tone: 'unreached', label: 'No mail reached a vendor' };
  if (repliedCount === 0) return { tone: 'waiting', label: 'Awaiting replies' };
  const repliedPart = `${repliedCount} of ${contactCount} replied`;
  if (quoteCount > 0) {
    return {
      tone: 'quoted',
      label: `${quoteCount === 1 ? '1 quote' : `${quoteCount} quotes`} · ${repliedPart}`,
    };
  }
  return { tone: 'replied', label: repliedPart };
}

export function formatRoute(rfq: RfqListItemResponse['rfq']): string {
  return `${rfq.originPort} → ${rfq.destinationPort}${rfq.incoterm ? ` · ${rfq.incoterm}` : ''}`;
}
