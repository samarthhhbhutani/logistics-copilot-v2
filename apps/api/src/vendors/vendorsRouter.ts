import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import type { Vendor, VendorContact, VendorRepository } from '@lc/core';
import {
  createVendorBodySchema,
  createVendorContactBodySchema,
  updateVendorBodySchema,
  updateVendorContactBodySchema,
} from '@lc/contract';
import type { ListVendorsResponse, VendorContactResponse, VendorResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';
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
 *   PATCH /:vendorId                        rename, recategorise, edit notes, archive/restore
 *   POST  /:vendorId/contacts               add a person; 409 contact_email_taken
 *   PATCH /:vendorId/contacts/:contactId    edit a person, archive/restore
 * Every write answers 200 with the whole vendor, contacts included. Nothing is ever deleted.
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

  router.patch('/:vendorId', requireSession, async (request, response) => {
    const vendorId = parseIdOr404(request.params.vendorId);
    const changes = parseRequestBody(updateVendorBodySchema, request.body);
    const { tenantId } = getSession(response);
    const updateResult = await vendorRepository.updateVendor(tenantId, vendorId, changes);
    if (updateResult.outcome === 'vendor_not_found') throw createHttpError(404, 'vendor_not_found');
    if (updateResult.outcome === 'vendor_name_taken')
      throw createHttpError(409, 'vendor_name_taken');
    response.json(toVendorResponse(updateResult.vendor));
  });

  router.post('/:vendorId/contacts', requireSession, async (request, response) => {
    const vendorId = parseIdOr404(request.params.vendorId);
    const contactToAdd = parseRequestBody(createVendorContactBodySchema, request.body);
    const { tenantId } = getSession(response);
    const addResult = await vendorRepository.addContact(tenantId, vendorId, contactToAdd);
    if (addResult.outcome === 'vendor_not_found') throw createHttpError(404, 'vendor_not_found');
    if (addResult.outcome === 'contact_email_taken')
      throw createHttpError(409, 'contact_email_taken');
    response.json(toVendorResponse(addResult.vendor));
  });

  router.patch('/:vendorId/contacts/:contactId', requireSession, async (request, response) => {
    const vendorId = parseIdOr404(request.params.vendorId);
    const contactId = parseIdOr404(request.params.contactId);
    const changes = parseRequestBody(updateVendorContactBodySchema, request.body);
    const { tenantId } = getSession(response);
    const updateResult = await vendorRepository.updateContact(
      tenantId,
      vendorId,
      contactId,
      changes,
    );
    if (updateResult.outcome === 'contact_not_found')
      throw createHttpError(404, 'contact_not_found');
    if (updateResult.outcome === 'contact_email_taken')
      throw createHttpError(409, 'contact_email_taken');
    response.json(toVendorResponse(updateResult.vendor));
  });

  return router;
}
