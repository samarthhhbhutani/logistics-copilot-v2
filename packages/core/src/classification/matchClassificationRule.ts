import type { ClassificationLabel } from './classificationLabel.js';
import type { ClassificationRule } from './classificationRule.js';

export interface RuleMatch {
  ruleId: string;
  label: ClassificationLabel;
}

/**
 * The domain a sender pattern without "@" is compared against: the lowercased part after the
 * last "@". Undefined when the address has no "@" or nothing after it.
 */
export function senderDomain(senderEmail: string): string | undefined {
  const atIndex = senderEmail.lastIndexOf('@');
  if (atIndex < 0 || atIndex === senderEmail.length - 1) return undefined;
  return senderEmail.slice(atIndex + 1).toLowerCase();
}

/**
 * First matching rule by ascending priority, or undefined. Pure: the caller loads the tenant's
 * enabled rules once per mail; `enabled` is not re-checked here. A mail with no sender address can match nothing.
 */
export function matchClassificationRule(
  rules: readonly ClassificationRule[],
  senderEmail: string | undefined,
): RuleMatch | undefined {
  if (!senderEmail) return undefined;
  const normalizedAddress = senderEmail.trim().toLowerCase();
  const domain = senderDomain(normalizedAddress);
  const sortedRules = [...rules].sort(
    (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
  );
  for (const rule of sortedRules) {
    const pattern = rule.senderPattern.trim().toLowerCase();
    if (pattern === '') continue;
    const matches = pattern.includes('@') ? pattern === normalizedAddress : pattern === domain;
    if (matches) return { ruleId: rule.id, label: rule.label };
  }
  return undefined;
}
