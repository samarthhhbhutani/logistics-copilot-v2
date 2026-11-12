import { describe, expect, it } from 'vitest';
import { buildHistoryListParams, collectWatchedMessageIds } from './gmailHistory.js';

describe('buildHistoryListParams', () => {
  it('asks for new messages and label additions as repeated keys, not a comma-joined list', () => {
    const params = buildHistoryListParams(4567n);
    expect(params.getAll('historyTypes')).toEqual(['messageAdded', 'labelAdded']);
    expect(params.get('startHistoryId')).toBe('4567');
    expect(params.has('pageToken')).toBe(false);
    expect(params.toString()).toBe(
      'startHistoryId=4567&historyTypes=messageAdded&historyTypes=labelAdded',
    );
  });

  it('carries the page token for later pages', () => {
    expect(buildHistoryListParams(1n, 'page-2').get('pageToken')).toBe('page-2');
  });
});

describe('collectWatchedMessageIds', () => {
  it('collects a mail filtered to spam and later moved to the inbox exactly once', () => {
    const messageIds = new Set<string>();
    collectWatchedMessageIds(
      [
        { messagesAdded: [{ message: { id: 'spam-then-inbox', labelIds: ['SPAM', 'UNREAD'] } }] },
        {
          labelsAdded: [
            {
              message: { id: 'spam-then-inbox', labelIds: ['INBOX', 'UNREAD'] },
              labelIds: ['INBOX'],
            },
          ],
        },
        {
          labelsAdded: [
            { message: { id: 'spam-then-inbox', labelIds: ['INBOX'] }, labelIds: ['IMPORTANT'] },
          ],
        },
      ],
      messageIds,
    );
    expect([...messageIds]).toEqual(['spam-then-inbox']);
  });

  it('keeps ignoring changes that never touch a watched label', () => {
    const messageIds = new Set<string>();
    collectWatchedMessageIds(
      [
        { messagesAdded: [{ message: { id: 'draft', labelIds: ['DRAFT'] } }] },
        { messagesAdded: [{ message: { id: 'no-labels' } }] },
        {
          labelsAdded: [
            // Starring an inbox mail adds STARRED only; the mail itself was collected when it arrived.
            { message: { id: 'starred', labelIds: ['INBOX', 'STARRED'] }, labelIds: ['STARRED'] },
            {
              message: { id: 'archived-then-labelled', labelIds: ['Vendors'] },
              labelIds: ['Vendors'],
            },
          ],
        },
        {},
      ],
      messageIds,
    );
    expect(messageIds.size).toBe(0);
  });

  it('keeps history order across pages and both change types, including sent mail', () => {
    const messageIds = new Set<string>(['first-page']);
    collectWatchedMessageIds(
      [
        { messagesAdded: [{ message: { id: 'inbound', labelIds: ['INBOX', 'UNREAD'] } }] },
        { messagesAdded: [{ message: { id: 'outbound', labelIds: ['SENT'] } }] },
        {
          labelsAdded: [
            { message: { id: 'unarchived', labelIds: ['INBOX'] }, labelIds: ['INBOX'] },
          ],
        },
        { messagesAdded: [{ message: { id: 'inbound', labelIds: ['INBOX'] } }] },
      ],
      messageIds,
    );
    expect([...messageIds]).toEqual(['first-page', 'inbound', 'outbound', 'unarchived']);
  });
});
