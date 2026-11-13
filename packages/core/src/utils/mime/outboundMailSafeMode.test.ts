import { describe, expect, it } from 'vitest';
import {
  assertOutboundRedirectMatchesStage,
  redirectOutboundMessage,
} from './outboundMailSafeMode.js';

const message = {
  from: { name: 'Ops Desk', address: 'ops@tenant.example' },
  to: [
    { name: 'Vendor One', address: 'quotes@vendor-one.example' },
    { name: '', address: 'sales@vendor-two.example' },
  ],
  cc: [{ name: 'Desk', address: 'desk@tenant.example' }],
  subject: 'Re: RFQ 123',
  text: 'Please quote.',
  messageId: '<rfq-123.2@tenant.example>',
  inReplyTo: '<vendor-reply-1@vendor-one.example>',
  references: ['<rfq-123.1@tenant.example>', '<vendor-reply-1@vendor-one.example>'],
  extraHeaders: { 'X-Lc-Rfq-Id': 'rfq-123' },
};

describe('redirectOutboundMessage', () => {
  it('addresses the mail to the redirect only and records who it was meant for', () => {
    const redirected = redirectOutboundMessage(message, 'staging-inbox@tenant.example');
    expect(redirected.to).toEqual([{ name: '', address: 'staging-inbox@tenant.example' }]);
    expect(redirected.cc).toBeUndefined();
    expect(redirected.extraHeaders).toEqual({
      'X-Lc-Rfq-Id': 'rfq-123',
      'X-Lc-Intended-To': 'Vendor One <quotes@vendor-one.example>, sales@vendor-two.example',
      'X-Lc-Intended-Cc': 'Desk <desk@tenant.example>',
    });
    expect(redirected.text).toBe(
      '[Redirected by safe mode. Intended To: Vendor One <quotes@vendor-one.example>, sales@vendor-two.example]\n' +
        '[Intended Cc: Desk <desk@tenant.example>]\n\n' +
        'Please quote.',
    );
  });

  it('keeps everything that makes the mail thread: from, subject, Message-ID, In-Reply-To, References', () => {
    const redirected = redirectOutboundMessage(message, 'staging-inbox@tenant.example');
    expect(redirected).toMatchObject({
      from: message.from,
      subject: message.subject,
      messageId: message.messageId,
      inReplyTo: message.inReplyTo,
      references: message.references,
    });
    expect(message.to).toHaveLength(2);
  });

  it('omits the Cc header and note when there was no Cc', () => {
    const redirected = redirectOutboundMessage({ ...message, cc: undefined }, 'x@tenant.example');
    expect(redirected.extraHeaders).not.toHaveProperty('X-Lc-Intended-Cc');
    expect(redirected.text).not.toContain('Intended Cc');
  });
});

describe('assertOutboundRedirectMatchesStage', () => {
  it('requires a redirect on staging and refuses one on prod; dev takes either', () => {
    expect(() => assertOutboundRedirectMatchesStage({ stage: 'staging' })).toThrow(
      /required when STAGE=staging/,
    );
    expect(() =>
      assertOutboundRedirectMatchesStage({ stage: 'prod', redirectAllMailTo: 'me@tenant.example' }),
    ).toThrow(/must be unset when STAGE=prod/);
    expect(() => assertOutboundRedirectMatchesStage({ stage: 'prod' })).not.toThrow();
    expect(() =>
      assertOutboundRedirectMatchesStage({
        stage: 'staging',
        redirectAllMailTo: 'me@tenant.example',
      }),
    ).not.toThrow();
    expect(() => assertOutboundRedirectMatchesStage({ stage: 'dev' })).not.toThrow();
    expect(() =>
      assertOutboundRedirectMatchesStage({ stage: 'dev', redirectAllMailTo: 'me@tenant.example' }),
    ).not.toThrow();
  });
});
