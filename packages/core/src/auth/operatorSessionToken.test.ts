import { describe, expect, it } from 'vitest';
import { createOperatorSessionToken, verifyOperatorSessionToken } from './operatorSessionToken.js';
import { createSessionToken, verifySessionToken } from './sessionToken.js';

const secret = 'test-session-secret-that-is-at-least-32-chars';
const operator = { operatorId: '11111111-1111-4111-8111-111111111111', email: 'ops@example.com' };

describe('operatorSessionToken', () => {
  it('round-trips the operator claims', async () => {
    const token = await createOperatorSessionToken(operator, secret);
    expect(await verifyOperatorSessionToken(token, secret)).toEqual(operator);
  });

  it('rejects a mailbox session token, and a mailbox verifier rejects an operator token', async () => {
    const mailboxToken = await createSessionToken({ mailboxId: 'm', tenantId: 't' }, secret);
    expect(await verifyOperatorSessionToken(mailboxToken, secret)).toBeUndefined();
    const operatorToken = await createOperatorSessionToken(operator, secret);
    expect(await verifySessionToken(operatorToken, secret)).toBeUndefined();
  });

  it('rejects a token signed with another secret', async () => {
    const token = await createOperatorSessionToken(
      operator,
      'another-secret-that-is-also-32-chars-long',
    );
    expect(await verifyOperatorSessionToken(token, secret)).toBeUndefined();
  });
});
