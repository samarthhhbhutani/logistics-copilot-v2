import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import type { Vendor, VendorContact, VendorRepository } from '@lc/core';
import { createVendorBodySchema } from '@lc/contract';
import type { ListVendorsResponse, VendorContactResponse, VendorResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseRequestBody } from '../http/parseRequestBody.js';

export interface VendorsRouterDependencies {
  vendorRepository: VendorRepository;
  requireSession: RequestHandler;
}

function toVendorContactResponse(contact: VendorContact): VendorContactResponse {
  return {
    id: contact.id,
    contactName: contact.contactName,
    emailAddress: contact.emailAddress,
    phoneNumber: contact.phoneNumber,
    active: contact.active,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

export function toVendorResponse(vendor: Vendor): VendorResponse {
  return {
    id: vendor.id,
    vendorName: vendor.vendorName,
    category: vendor.category,
    notes: vendor.notes,
    active: vendor.active,
    contacts: vendor.contacts.map(toVendorContactResponse),
    createdAt: vendor.createdAt.toISOString(),
    updatedAt: vendor.updatedAt.toISOString(),
  };
}

/**
 * The session tenant's vendors, mounted at /v1/mailbox/vendors. Vendors are tenant-wide: every
 * mailbox of the desk sees the same list. The tenant always comes from the session, never the body.
 *   GET  /    every vendor with its contacts, archived included, by name
 *   POST /    create one with its contacts; 201 with the stored vendor; 409 vendor_name_taken when
 *             the tenant already has a vendor of that name
 */
export function createVendorsRouter({
  vendorRepository,
  requireSession,
}: VendorsRouterDependencies): Router {
  const router = express.Router();

  router.get('/', requireSession, async (_request, response) => {
    const { tenantId } = getSession(response);
    const vendors = await vendorRepository.listVendors(tenantId);
    const body: ListVendorsResponse = { vendors: vendors.map(toVendorResponse) };
    response.json(body);
  });

  router.post('/', requireSession, async (request, response) => {
    const vendorToCreate = parseRequestBody(createVendorBodySchema, request.body);
    const { tenantId } = getSession(response);
    const createResult = await vendorRepository.createVendor(tenantId, vendorToCreate);
    if (createResult.outcome === 'vendor_name_taken')
      throw createHttpError(409, 'vendor_name_taken');
    response.status(201).json(toVendorResponse(createResult.vendor));
  });

  return router;
}
