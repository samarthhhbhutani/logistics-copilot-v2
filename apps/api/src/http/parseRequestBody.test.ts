import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseRequestBody } from './parseRequestBody.js';

const schema = z.object({ email: z.email(), count: z.number().int() });

describe('parseRequestBody', () => {
  it('returns typed data for a valid body', () => {
    expect(parseRequestBody(schema, { email: 'a@b.co', count: 2 })).toEqual({
      email: 'a@b.co',
      count: 2,
    });
  });

  it('throws a 400 http-error naming every invalid field', () => {
    expect(() => parseRequestBody(schema, { email: 'nope', count: 1.5 })).toThrow(
      expect.objectContaining({
        status: 400,
        expose: true,
        message: expect.stringMatching(/email.*count/s),
      }),
    );
  });
});
