import { Prisma } from '../db/generated/client.js';
import type { PrismaClient } from '../db/prismaClient.js';
import {
  CLASSIFICATION_LABEL_BY_PRISMA_LABEL,
  PRISMA_LABEL_BY_CLASSIFICATION_LABEL,
} from './classificationLabel.js';
import type { ClassificationLabel } from './classificationLabel.js';
import type { ClassificationRule } from './classificationRule.js';

export interface NewClassificationRule {
  /** Already normalised (trimmed, lowercased) and validated by the contract schema. */
  senderPattern: string;
  label: ClassificationLabel;
  priority: number;
}

/** Rules are loaded for every inbound mail, so a tenant's list is kept small. */
export const MAX_CLASSIFICATION_RULES_PER_TENANT = 200;

export type CreateRuleResult =
  | { outcome: 'created'; rule: ClassificationRule }
  /** (tenant_id, sender_pattern) already has a rule; the caller answers 409. */
  | { outcome: 'duplicate_pattern' }
  | { outcome: 'too_many_rules' };

export interface ClassificationRuleRepository {
  /** The tenant's enabled rules, lowest priority value first. Empty when the tenant has none. */
  listEnabledRules(tenantId: string): Promise<ClassificationRule[]>;
  /** Every rule of the tenant, disabled included, lowest priority value first. */
  listRules(tenantId: string): Promise<ClassificationRule[]>;
  createRule(tenantId: string, newRule: NewClassificationRule): Promise<CreateRuleResult>;
}

const RULE_SELECT = {
  id: true,
  priority: true,
  senderPattern: true,
  label: true,
  enabled: true,
  createdAt: true,
} as const;

type RuleRow = {
  id: string;
  priority: number;
  senderPattern: string;
  label: keyof typeof CLASSIFICATION_LABEL_BY_PRISMA_LABEL;
  enabled: boolean;
  createdAt: Date;
};

function toClassificationRule(row: RuleRow): ClassificationRule {
  return {
    id: row.id,
    priority: row.priority,
    senderPattern: row.senderPattern,
    label: CLASSIFICATION_LABEL_BY_PRISMA_LABEL[row.label],
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

export function createPrismaClassificationRuleRepository(
  prismaClient: PrismaClient,
): ClassificationRuleRepository {
  return {
    async listEnabledRules(tenantId) {
      const rules = await prismaClient.classificationRule.findMany({
        where: { tenantId, enabled: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: RULE_SELECT,
      });
      return rules.map(toClassificationRule);
    },
    async listRules(tenantId) {
      const rules = await prismaClient.classificationRule.findMany({
        where: { tenantId },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: RULE_SELECT,
      });
      return rules.map(toClassificationRule);
    },
    async createRule(tenantId, newRule) {
      // Count then insert without a lock: two racing creates may overshoot the cap by one, which is
      // a soft limit anyway. The unique index, not this code, is what rejects a duplicate pattern.
      const ruleCount = await prismaClient.classificationRule.count({ where: { tenantId } });
      if (ruleCount >= MAX_CLASSIFICATION_RULES_PER_TENANT) return { outcome: 'too_many_rules' };
      try {
        const rule = await prismaClient.classificationRule.create({
          data: {
            tenantId,
            priority: newRule.priority,
            senderPattern: newRule.senderPattern,
            label: PRISMA_LABEL_BY_CLASSIFICATION_LABEL[newRule.label],
          },
          select: RULE_SELECT,
        });
        return { outcome: 'created', rule: toClassificationRule(rule) };
      } catch (error) {
        if (isUniqueViolation(error)) return { outcome: 'duplicate_pattern' };
        throw error;
      }
    },
  };
}

/** Prisma's code for a unique-index violation; the only error createRule turns into a result. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
