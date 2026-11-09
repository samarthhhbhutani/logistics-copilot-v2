import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMAIL_PAGE_SIZE,
  MAX_EMAIL_PAGE_SIZE,
  listEmailsQuerySchema,
  listEmailsResponseSchema,
} from './index.js';
import type { EmailSummaryResponse } from './index.js';

const scope = {
  mailboxId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000003',
};
const email: EmailSummaryResponse = {
  id: '00000000-0000-4000-8000-000000000001',
  gmailThreadId: 'thread-1',
  gmailLabel: 'inbox',
  sender: { name: 'Ravi Kumar', email: 'ravi@acme.com' },
  toRecipients: [{ name: '', address: 'ops@bhatia.example' }],
  subject: 'RFQ: 2x40HC Nhava Sheva to Jebel Ali',
  snippet: 'Please quote',
  receivedAt: '2026-11-09T12:59:00.000Z',
};

describe('listEmailsQuerySchema', () => {
  it('defaults the page size', () => {
    expect(listEmailsQuerySchema.parse({})).toEqual({ limit: DEFAULT_EMAIL_PAGE_SIZE });
  });

  it('coerces the query-string limit and keeps cursor and label', () => {
    expect(listEmailsQuerySchema.parse({ limit: '10', cursor: 'abc', label: 'sent' })).toEqual({
      limit: 10,
      cursor: 'abc',
      label: 'sent',
    });
  });

  it.each([
    { limit: '0' },
    { limit: String(MAX_EMAIL_PAGE_SIZE + 1) },
    { limit: '2.5' },
    { cursor: '' },
    { label: 'spam' },
  ])('rejects %j', (query) => {
    expect(listEmailsQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('listEmailsResponseSchema', () => {
  it('accepts a page with a next cursor', () => {
    const page = { ...scope, emails: [email], nextCursor: 'opaque' };
    expect(listEmailsResponseSchema.parse(page)).toEqual(page);
  });

  it('accepts a sender with no address on the last page', () => {
    const page = {
      ...scope,
      emails: [{ ...email, gmailLabel: 'sent', sender: { name: '', email: null } }],
      nextCursor: null,
    };
    expect(listEmailsResponseSchema.parse(page)).toEqual(page);
  });

  it.each([
    { emails: [{ ...email, gmailLabel: 'spam' }], nextCursor: null },
    { emails: [{ ...email, receivedAt: 'Mon, 9 Nov 2026' }], nextCursor: null },
    { emails: [{ ...email, sender: { name: 'Ravi Kumar' } }], nextCursor: null },
    { emails: [{ ...email, senderEmail: 'ravi@acme.com', sender: undefined }], nextCursor: null },
    { emails: [email] },
    { emails: null, nextCursor: null },
    { mailboxId: undefined, emails: [], nextCursor: null },
    { tenantId: undefined, emails: [], nextCursor: null },
  ])('rejects malformed page %#', (page) => {
    expect(listEmailsResponseSchema.safeParse({ ...scope, ...page }).success).toBe(false);
  });
});
