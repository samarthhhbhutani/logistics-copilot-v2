import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import { isNotDrafted } from '@lc/core';
import type {
  EmailReadRepository,
  RfqMailDrafter,
  Vendor,
  VendorCategory,
  VendorRepository,
} from '@lc/core';
import { draftRfqMailsBodySchema } from '@lc/contract';
import type { DraftRfqMailsResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseRequestBody } from '../http/parseRequestBody.js';

export interface RfqDraftsRouterDependencies {
  emailReadRepository: EmailReadRepository;
  vendorRepository: VendorRepository;
  /** Undefined when no OPENAI_API_KEY is configured: the route answers 503 and the operator writes the mails by hand. */
  rfqMailDrafter: RfqMailDrafter | undefined;
  requireSession: RequestHandler;
}

/**
 * Vendor mail drafts for the RFQ page, mounted at /v1/mailbox/rfqs.
 *   POST /drafts   { sourceEmailId, details, vendorIds }  200 { drafts: one per vendor category }
 *                  404 email_not_found | vendor_not_found; 503 drafts_unavailable; 422 drafts_failed
 * Text only: the operator edits it on screen and Send (4.4b) is what reaches Gmail. All or nothing:
 * with two categories a half result would leave the operator guessing which mail to retry.
 */
export function createRfqDraftsRouter({
  emailReadRepository,
  vendorRepository,
  rfqMailDrafter,
  requireSession,
}: RfqDraftsRouterDependencies): Router {
  const router = express.Router();

  router.post('/drafts', requireSession, async (request, response) => {
    const body = parseRequestBody(draftRfqMailsBodySchema, request.body);
    const scope = getSession(response);
    const email = await emailReadRepository.findEmail(scope, body.sourceEmailId);
    if (!email) throw createHttpError(404, 'email_not_found');
    const categories = await selectedVendorCategories(
      vendorRepository,
      scope.tenantId,
      body.vendorIds,
    );
    if (!categories) throw createHttpError(404, 'vendor_not_found');
    // 5xx are answered here: the app's error handler reports any thrown 5xx as internal_error.
    if (!rfqMailDrafter) {
      response.status(503).json({ error: 'drafts_unavailable' });
      return;
    }

    const customerMail = {
      senderName: email.senderName,
      senderEmail: email.senderEmail ?? undefined,
      subject: email.subject,
      bodyText: email.bodyText,
    };
    const outcomes = await Promise.all(
      categories.map(async (category) => ({
        category,
        outcome: await rfqMailDrafter.draft({ category, details: body.details, customerMail }),
      })),
    );
    const notDrafted = outcomes.flatMap(({ category, outcome }) =>
      isNotDrafted(outcome) ? [{ category, failure: outcome }] : [],
    );
    if (notDrafted.length > 0) {
      const detail = notDrafted
        .map((entry) => `${entry.category}: ${entry.failure.detail}`)
        .join('; ');
      if (notDrafted.some((entry) => entry.failure.outcome === 'retry')) {
        console.warn('rfq drafts: provider unavailable', {
          sourceEmailId: body.sourceEmailId,
          detail,
        });
        response.status(503).json({ error: 'drafts_unavailable' });
        return;
      }
      console.warn('rfq drafts: failed', { sourceEmailId: body.sourceEmailId, detail });
      throw createHttpError(422, 'drafts_failed');
    }
    const responseBody: DraftRfqMailsResponse = {
      drafts: outcomes.flatMap(({ category, outcome }) =>
        outcome.outcome === 'drafted'
          ? [
              {
                category,
                ...outcome.draft,
                model: outcome.model,
                promptVersion: outcome.promptVersion,
              },
            ]
          : [],
      ),
    };
    response.status(200).json(responseBody);
  });

  return router;
}

/**
 * The categories among the chosen vendors, in a fixed order so the drafts come back the same way
 * every time; undefined when any id is not an active vendor of the tenant.
 */
async function selectedVendorCategories(
  vendorRepository: VendorRepository,
  tenantId: string,
  vendorIds: string[],
): Promise<VendorCategory[] | undefined> {
  const vendors = await vendorRepository.listVendors(tenantId);
  const activeById = new Map(
    vendors
      .filter((vendor) => vendor.active)
      .map((vendor): [string, Vendor] => [vendor.id, vendor]),
  );
  const selected = vendorIds.map((vendorId) => activeById.get(vendorId));
  if (selected.some((vendor) => vendor === undefined)) return undefined;
  const categories = new Set((selected as Vendor[]).map((vendor) => vendor.category));
  return CATEGORY_ORDER.filter((category) => categories.has(category));
}

const CATEGORY_ORDER: VendorCategory[] = ['carrier', 'cha'];
