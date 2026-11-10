import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import type { ClassificationRule, ClassificationRuleRepository } from '@lc/core';
import { createClassificationRuleBodySchema } from '@lc/contract';
import type { ClassificationRuleResponse, ListClassificationRulesResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseRequestBody } from '../http/parseRequestBody.js';

export interface ClassificationRulesRouterDependencies {
  classificationRuleRepository: ClassificationRuleRepository;
  requireSession: RequestHandler;
}

function toClassificationRuleResponse(rule: ClassificationRule): ClassificationRuleResponse {
  return {
    id: rule.id,
    priority: rule.priority,
    senderPattern: rule.senderPattern,
    label: rule.label,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
  };
}

/**
 * The session tenant's sender rules, mounted at /v1/mailbox/classification-rules. Rules are
 * tenant-wide: every mailbox of the desk sees and edits the same list. The tenant always comes
 * from the session, never from the body.
 *   GET  /    every rule, disabled included, priority ascending
 *   POST /    create one; 201 with the stored rule (pattern normalised); 409 rule_exists when the
 *             tenant already has a rule for that pattern, 409 too_many_rules at the per-tenant cap
 */
export function createClassificationRulesRouter({
  classificationRuleRepository,
  requireSession,
}: ClassificationRulesRouterDependencies): Router {
  const router = express.Router();

  router.get('/', requireSession, async (_request, response) => {
    const { tenantId } = getSession(response);
    const rules = await classificationRuleRepository.listRules(tenantId);
    const body: ListClassificationRulesResponse = {
      rules: rules.map(toClassificationRuleResponse),
    };
    response.json(body);
  });

  router.post('/', requireSession, async (request, response) => {
    const body = parseRequestBody(createClassificationRuleBodySchema, request.body);
    const { tenantId } = getSession(response);
    const result = await classificationRuleRepository.createRule(tenantId, body);
    if (result.outcome === 'duplicate_pattern') throw createHttpError(409, 'rule_exists');
    if (result.outcome === 'too_many_rules') throw createHttpError(409, 'too_many_rules');
    response.status(201).json(toClassificationRuleResponse(result.rule));
  });

  return router;
}
