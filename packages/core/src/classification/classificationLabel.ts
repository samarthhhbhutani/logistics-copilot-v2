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
] as const;
export type ClassificationLabel = (typeof CLASSIFICATION_LABELS)[number];
/** Derived from the thread alone: not a rule target (contract schema) and not offered to the model (classifier schema). */
export const THREAD_DERIVED_LABEL = 'customer_reply' satisfies ClassificationLabel;
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
};
export const CLASSIFICATION_LABEL_BY_PRISMA_LABEL: Record<
  PrismaClassificationLabel,
  ClassificationLabel
> = {
  GENERAL: 'general',
  CUSTOMER_REQUEST: 'customer_request',
  CUSTOMER_REPLY: 'customer_reply',
  RATE_CARD: 'rate_card',
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
