import { describe, expect, it } from 'vitest';
import { decodeRfqListCursor, encodeRfqListCursor } from './rfqListCursor.js';

describe('rfqListCursor', () => {
  it('round-trips a position and is URL-safe', () => {
    const position = {
      createdAt: new Date('2026-11-16T12:39:01.000Z'),
      id: 'ef3e83d4-7617-49d5-8967-49ba2dac5267',
    };
    const cursor = encodeRfqListCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRfqListCursor(cursor)).toEqual(position);
  });

  it.each([
    ['garbage', 'not-a-cursor!!'],
    ['json that is not an object', Buffer.from('[1]').toString('base64url')],
    ['a missing id', Buffer.from('{"createdAt":"2026-11-16T12:39:01.000Z"}').toString('base64url')],
    [
      'an id that is not a uuid',
      Buffer.from('{"createdAt":"2026-11-16T12:39:01.000Z","id":"rfq-1"}').toString('base64url'),
    ],
    [
      'an invalid date',
      Buffer.from('{"createdAt":"yesterday","id":"ef3e83d4-7617-49d5-8967-49ba2dac5267"}').toString(
        'base64url',
      ),
    ],
    [
      'a date outside the sane range',
      Buffer.from(
        '{"createdAt":"1999-01-01T00:00:00.000Z","id":"ef3e83d4-7617-49d5-8967-49ba2dac5267"}',
      ).toString('base64url'),
    ],
  ])('rejects %s', (_name, cursor) => {
    expect(decodeRfqListCursor(cursor)).toBeUndefined();
  });
});
