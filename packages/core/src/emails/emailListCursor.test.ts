import { describe, expect, it } from 'vitest';
import { decodeEmailListCursor, encodeEmailListCursor } from './emailListCursor.js';

describe('emailListCursor', () => {
  it('round-trips a position and is URL-safe', () => {
    const position = {
      receivedAt: new Date('2026-11-09T12:39:01.000Z'),
      id: 'ef3e83d4-7617-49d5-8967-49ba2dac5267',
    };
    const cursor = encodeEmailListCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeEmailListCursor(cursor)).toEqual(position);
  });

  it.each([
    ['garbage', 'not-a-cursor!!'],
    ['json that is not an object', Buffer.from('[1]').toString('base64url')],
    [
      'a missing id',
      Buffer.from('{"receivedAt":"2026-11-09T12:39:01.000Z"}').toString('base64url'),
    ],
    [
      'an empty id',
      Buffer.from('{"receivedAt":"2026-11-09T12:39:01.000Z","id":""}').toString('base64url'),
    ],
    ['an invalid date', Buffer.from('{"receivedAt":"yesterday","id":"e1"}').toString('base64url')],
  ])('rejects %s', (_name, cursor) => {
    expect(decodeEmailListCursor(cursor)).toBeUndefined();
  });
});
