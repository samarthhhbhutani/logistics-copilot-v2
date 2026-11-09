import { describe, expect, it } from 'vitest';
import { loginRequestSchema, sessionResponseSchema } from './index.js';

const mailboxId = '0f8b6a52-3c1d-4e7a-9b2f-5d6c7e8f9a01';
const tenantId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('loginRequestSchema', () => {
  it('lowercases the email', () => {
    expect(loginRequestSchema.parse({ email: 'Ops@Bhatia.Example', password: 'secret1' })).toEqual({
      email: 'ops@bhatia.example',
      password: 'secret1',
    });
  });

  it('rejects an invalid email and a short password', () => {
    const result = loginRequestSchema.safeParse({ email: 'not-an-email', password: '12345' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toEqual(['email', 'password']);
  });
});

describe('sessionResponseSchema', () => {
  it('accepts mailbox and tenant ids', () => {
    expect(sessionResponseSchema.parse({ mailboxId, tenantId })).toEqual({ mailboxId, tenantId });
  });

  it.each([{ mailboxId }, { mailboxId, tenantId: 'tenant-1' }, null])(
    'rejects malformed %j',
    (body) => {
      expect(sessionResponseSchema.safeParse(body).success).toBe(false);
    },
  );
});
