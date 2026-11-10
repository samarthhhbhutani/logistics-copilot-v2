import { z } from 'zod';

/** Every label a classification row can carry. */
export const classificationLabelSchema = z.enum([
  'general',
  'customer_request',
  'customer_reply',
  'rate_card',
]);
export type ClassificationLabel = z.infer<typeof classificationLabelSchema>;
export const classificationSourceSchema = z.enum(['thread', 'rule', 'llm', 'user']);
export type ClassificationSource = z.infer<typeof classificationSourceSchema>;

export const DEFAULT_CLASSIFICATION_RULE_PRIORITY = 100;
export const MAX_SENDER_PATTERN_LENGTH = 254;

const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Who a rule is about, normalised the way the matcher compares it (trimmed, lowercased). With an
 * "@" it must be a whole address and matches that sender only; otherwise a domain, matching every
 * sender at exactly that domain (subdomains do not match).
 */
export const senderPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SENDER_PATTERN_LENGTH)
  .transform((value) => value.toLowerCase())
  .refine(
    (value) => (value.includes('@') ? EMAIL_ADDRESS_PATTERN : DOMAIN_PATTERN).test(value),
    'must be an email address (ravi@acme.com) or a domain (acme.com)',
  );

/** POST /v1/mailbox/classification-rules. Lower priority value is checked first. */
export const createClassificationRuleBodySchema = z.object({
  senderPattern: senderPatternSchema,
  /** customer_reply is derived from the thread and cannot be declared by a rule. */
  label: classificationLabelSchema.exclude(['customer_reply']),
  priority: z.number().int().min(0).max(10_000).default(DEFAULT_CLASSIFICATION_RULE_PRIORITY),
});
export type CreateClassificationRuleBody = z.input<typeof createClassificationRuleBodySchema>;

export const classificationRuleSchema = z.object({
  id: z.uuid(),
  priority: z.number().int(),
  senderPattern: z.string(),
  label: classificationLabelSchema,
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ClassificationRuleResponse = z.infer<typeof classificationRuleSchema>;

/** GET /v1/mailbox/classification-rules: every rule of the session's tenant, disabled included, priority ascending. */
export const listClassificationRulesResponseSchema = z.object({
  rules: z.array(classificationRuleSchema),
});
export type ListClassificationRulesResponse = z.infer<typeof listClassificationRulesResponseSchema>;
