import { describe, expect, it } from 'vitest';
import { matchClassificationRule, senderDomain } from './matchClassificationRule.js';
import type { ClassificationRule } from './classificationRule.js';

const ruleState = { enabled: true, createdAt: new Date('2026-11-01T00:00:00Z') };

const domainRule: ClassificationRule = {
  ...ruleState,
  id: 'rule-domain',
  priority: 20,
  senderPattern: 'Acme.com',
  label: 'general',
};
const addressRule: ClassificationRule = {
  ...ruleState,
  id: 'rule-address',
  priority: 10,
  senderPattern: 'Ravi@acme.com',
  label: 'customer_request',
};

describe('senderDomain', () => {
  it('returns the lowercased part after the last @', () => {
    expect(senderDomain('ravi@ACME.com')).toBe('acme.com');
    expect(senderDomain('"odd@name"@mail.acme.com')).toBe('mail.acme.com');
  });

  it('is undefined for an address without a domain', () => {
    expect(senderDomain('ravi')).toBeUndefined();
    expect(senderDomain('ravi@')).toBeUndefined();
  });
});

describe('matchClassificationRule', () => {
  it('matches a pattern with @ against the whole address, case-insensitively', () => {
    expect(matchClassificationRule([addressRule], 'RAVI@Acme.COM')).toEqual({
      ruleId: 'rule-address',
      label: 'customer_request',
    });
    expect(matchClassificationRule([addressRule], 'priya@acme.com')).toBeUndefined();
  });

  it('matches a pattern without @ against the domain only', () => {
    expect(matchClassificationRule([domainRule], 'priya@acme.com')).toEqual({
      ruleId: 'rule-domain',
      label: 'general',
    });
    expect(matchClassificationRule([domainRule], 'priya@mail.acme.com')).toBeUndefined();
    expect(matchClassificationRule([domainRule], 'acme.com@other.com')).toBeUndefined();
  });

  it('picks the lowest priority value first, whatever the input order', () => {
    expect(matchClassificationRule([domainRule, addressRule], 'ravi@acme.com')?.ruleId).toBe(
      'rule-address',
    );
    expect(matchClassificationRule([addressRule, domainRule], 'ravi@acme.com')?.ruleId).toBe(
      'rule-address',
    );
  });

  it('matches nothing without a sender address or rules', () => {
    expect(matchClassificationRule([domainRule], undefined)).toBeUndefined();
    expect(matchClassificationRule([], 'ravi@acme.com')).toBeUndefined();
  });

  it('ignores a blank pattern and tolerates surrounding whitespace', () => {
    const blank: ClassificationRule = {
      ...domainRule,
      id: 'blank',
      priority: 0,
      senderPattern: '  ',
    };
    expect(matchClassificationRule([blank, domainRule], ' ravi@acme.com ')?.ruleId).toBe(
      'rule-domain',
    );
  });
});
