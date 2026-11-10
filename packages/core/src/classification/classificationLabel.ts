import type {
  ClassificationLabel as PrismaClassificationLabel,
  ClassificationSource as PrismaClassificationSource,
} from '../db/generated/client.js';

/** What an inbound mail is for the desk; see the ClassificationLabel enum in schema.prisma. */
export type ClassificationLabel = 'general' | 'customer_request' | 'rate_card';
/** Who decided a label: a tenant rule, the LLM, or an operator correcting it. */
export type ClassificationSource = 'rule' | 'llm' | 'user';

// Prisma generates UPPER_CASE enum members; the API and the columns speak snake_case.
export const PRISMA_LABEL_BY_CLASSIFICATION_LABEL: Record<
  ClassificationLabel,
  PrismaClassificationLabel
> = {
  general: 'GENERAL',
  customer_request: 'CUSTOMER_REQUEST',
  rate_card: 'RATE_CARD',
};
export const CLASSIFICATION_LABEL_BY_PRISMA_LABEL: Record<
  PrismaClassificationLabel,
  ClassificationLabel
> = {
  GENERAL: 'general',
  CUSTOMER_REQUEST: 'customer_request',
  RATE_CARD: 'rate_card',
};
export const PRISMA_SOURCE_BY_CLASSIFICATION_SOURCE: Record<
  ClassificationSource,
  PrismaClassificationSource
> = {
  rule: 'RULE',
  llm: 'LLM',
  user: 'USER',
};
