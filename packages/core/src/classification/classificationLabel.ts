import type {
  ClassificationLabel as PrismaClassificationLabel,
  ClassificationSource as PrismaClassificationSource,
} from '../db/generated/client.js';

/** What an inbound mail is for the desk; see the ClassificationLabel enum in schema.prisma. */
export const CLASSIFICATION_LABELS = [
  'general',
  'customer_request',
  'customer_reply',
  'rate_card',
  'vendor_reply',
  'vendor_quote',
] as const;
export type ClassificationLabel = (typeof CLASSIFICATION_LABELS)[number];
/**
 * Labels that follow from what the mailbox already knows (the thread holds a customer_request; the
 * mail answers an RFQ of ours), so a rule cannot declare them (contract schema) and the general
 * classifier is never offered them (classifier schema). Operators may still set them by hand.
 */
export const DERIVED_ONLY_LABELS = [
  'customer_reply',
  'vendor_reply',
  'vendor_quote',
] as const satisfies readonly ClassificationLabel[];
/** Who decided a label: the thread it arrived in, a tenant rule, the LLM, or an operator correcting it. */
export type ClassificationSource = 'thread' | 'rule' | 'llm' | 'user';

// Prisma generates UPPER_CASE enum members; the API and the columns speak snake_case.
export const PRISMA_LABEL_BY_CLASSIFICATION_LABEL: Record<
  ClassificationLabel,
  PrismaClassificationLabel
> = {
  general: 'GENERAL',
  customer_request: 'CUSTOMER_REQUEST',
  customer_reply: 'CUSTOMER_REPLY',
  rate_card: 'RATE_CARD',
  vendor_reply: 'VENDOR_REPLY',
  vendor_quote: 'VENDOR_QUOTE',
};
export const CLASSIFICATION_LABEL_BY_PRISMA_LABEL: Record<
  PrismaClassificationLabel,
  ClassificationLabel
> = {
  GENERAL: 'general',
  CUSTOMER_REQUEST: 'customer_request',
  CUSTOMER_REPLY: 'customer_reply',
  RATE_CARD: 'rate_card',
  VENDOR_REPLY: 'vendor_reply',
  VENDOR_QUOTE: 'vendor_quote',
};
export const PRISMA_SOURCE_BY_CLASSIFICATION_SOURCE: Record<
  ClassificationSource,
  PrismaClassificationSource
> = {
  thread: 'THREAD',
  rule: 'RULE',
  llm: 'LLM',
  user: 'USER',
};
export const CLASSIFICATION_SOURCE_BY_PRISMA_SOURCE: Record<
  PrismaClassificationSource,
  ClassificationSource
> = {
  THREAD: 'thread',
  RULE: 'rule',
  LLM: 'llm',
  USER: 'user',
};
