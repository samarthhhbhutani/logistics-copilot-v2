import { describe, expect, it } from 'vitest';
import { replySubject } from './replySubject.js';

describe('replySubject', () => {
  it('prefixes a fresh subject with one Re:', () => {
    expect(replySubject('RFQ 123: 40ft HC Mumbai to Rotterdam')).toBe(
      'Re: RFQ 123: 40ft HC Mumbai to Rotterdam',
    );
  });

  it('collapses an existing Re/Fwd chain in any case or spacing to a single Re:', () => {
    expect(replySubject('Re: RFQ 123')).toBe('Re: RFQ 123');
    expect(replySubject('RE: Re:RFQ 123')).toBe('Re: RFQ 123');
    expect(replySubject('Fwd: FW: re: RFQ 123')).toBe('Re: RFQ 123');
    expect(replySubject('  Re:   RFQ 123  ')).toBe('Re: RFQ 123');
  });

  it('leaves a Re inside the subject alone', () => {
    expect(replySubject('Rates re: Mumbai lane')).toBe('Re: Rates re: Mumbai lane');
    expect(replySubject('Reminder: quote')).toBe('Re: Reminder: quote');
  });
});
