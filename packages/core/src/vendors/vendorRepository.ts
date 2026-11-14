import { Prisma } from '../db/generated/client.js';
import type { PrismaClient } from '../db/prismaClient.js';
import { PRISMA_ENUM_BY_VENDOR_CATEGORY, VENDOR_CATEGORY_BY_PRISMA_ENUM } from './vendorModels.js';
import type { Vendor, VendorCategory, VendorContact } from './vendorModels.js';

export interface VendorContactToCreate {
  contactName: string;
  /** Already normalised (trimmed, lowercased) and validated by the contract schema. */
  emailAddress: string;
  phoneNumber: string | null;
}

export interface VendorToCreate {
  vendorName: string;
  category: VendorCategory;
  notes: string | null;
  /** May be empty; the contract schema enforces the upper bound. */
  contacts: VendorContactToCreate[];
}

export type CreateVendorResult =
  | { outcome: 'created'; vendor: Vendor }
  /** The tenant already has a vendor of that name, compared case-insensitively; the caller answers 409. */
  | { outcome: 'vendor_name_taken' };

export type VendorChanges = Partial<Pick<Vendor, 'vendorName' | 'category' | 'notes' | 'active'>>;
export type VendorContactChanges = Partial<
  Pick<VendorContact, 'contactName' | 'emailAddress' | 'phoneNumber' | 'active'>
>;

/** Every write answers with the whole vendor, contacts included, so a client has one shape to render. */
export type UpdateVendorResult =
  | { outcome: 'updated'; vendor: Vendor }
  | { outcome: 'vendor_not_found' }
  | { outcome: 'vendor_name_taken' };

export type AddContactResult =
  | { outcome: 'added'; vendor: Vendor }
  | { outcome: 'vendor_not_found' }
  /** The vendor already has a contact at that address; the caller answers 409. */
  | { outcome: 'contact_email_taken' };

export type UpdateContactResult =
  | { outcome: 'updated'; vendor: Vendor }
  | { outcome: 'contact_not_found' }
  | { outcome: 'contact_email_taken' };

export interface VendorRepository {
  /** Every vendor of the tenant with its contacts, archived included, by name. */
  listVendors(tenantId: string): Promise<Vendor[]>;
  /** Vendor and contacts in one transaction, so a half-created vendor never exists. */
  createVendor(tenantId: string, vendor: VendorToCreate): Promise<CreateVendorResult>;
  updateVendor(
    tenantId: string,
    vendorId: string,
    changes: VendorChanges,
  ): Promise<UpdateVendorResult>;
  addContact(
    tenantId: string,
    vendorId: string,
    contact: VendorContactToCreate,
  ): Promise<AddContactResult>;
  updateContact(
    tenantId: string,
    vendorId: string,
    contactId: string,
    changes: VendorContactChanges,
  ): Promise<UpdateContactResult>;
}

const VENDOR_CONTACT_SELECT = {
  id: true,
  contactName: true,
  emailAddress: true,
  phoneNumber: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VendorContactSelect;

const VENDOR_SELECT = {
  id: true,
  vendorName: true,
  category: true,
  notes: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  contacts: {
    select: VENDOR_CONTACT_SELECT,
    orderBy: [{ contactName: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.VendorSelect;

type VendorRow = Prisma.VendorGetPayload<{ select: typeof VENDOR_SELECT }>;
type VendorContactRow = Prisma.VendorContactGetPayload<{ select: typeof VENDOR_CONTACT_SELECT }>;

function toVendorContact(row: VendorContactRow): VendorContact {
  return {
    id: row.id,
    contactName: row.contactName,
    emailAddress: row.emailAddress,
    phoneNumber: row.phoneNumber,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toVendor(row: VendorRow): Vendor {
  return {
    id: row.id,
    vendorName: row.vendorName,
    category: VENDOR_CATEGORY_BY_PRISMA_ENUM[row.category],
    notes: row.notes,
    active: row.active,
    contacts: row.contacts.map(toVendorContact),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createPrismaVendorRepository(prismaClient: PrismaClient): VendorRepository {
  /** A vendor of the tenant already spelled this name, in any case. */
  async function vendorNameTaken(tenantId: string, vendorName: string): Promise<boolean> {
    const sameName = await prismaClient.vendor.findFirst({
      where: { tenantId, vendorName: { equals: vendorName, mode: 'insensitive' } },
      select: { id: true },
    });
    return sameName !== null;
  }

  return {
    async listVendors(tenantId) {
      const rows = await prismaClient.vendor.findMany({
        where: { tenantId },
        orderBy: [{ vendorName: 'asc' }, { id: 'asc' }],
        select: VENDOR_SELECT,
      });
      return rows.map(toVendor);
    },

    async createVendor(tenantId, vendor) {
      // "Sea Lines" and "sea lines" are the same company. The unique index is case-sensitive, so the
      // check is done here; the index still catches two racing creates of the identical spelling.
      if (await vendorNameTaken(tenantId, vendor.vendorName))
        return { outcome: 'vendor_name_taken' };
      try {
        const row = await prismaClient.vendor.create({
          data: {
            tenantId,
            vendorName: vendor.vendorName,
            category: PRISMA_ENUM_BY_VENDOR_CATEGORY[vendor.category],
            notes: vendor.notes,
            contacts: {
              create: vendor.contacts.map((contact) => ({ tenantId, ...contact })),
            },
          },
          select: VENDOR_SELECT,
        });
        return { outcome: 'created', vendor: toVendor(row) };
      } catch (error) {
        if (isUniqueViolation(error)) return { outcome: 'vendor_name_taken' };
        throw error;
      }
    },

    async updateVendor(tenantId, vendorId, changes) {
      if (changes.vendorName !== undefined) {
        // One query answers both questions for a rename: is this vendor in the tenant, and does another
        // vendor of the tenant already spell that name (in any case)? Existence is decided first, so an
        // unknown id is always "not found", never a 409 that tells the caller which names exist.
        const candidates = await prismaClient.vendor.findMany({
          where: {
            tenantId,
            OR: [
              { id: vendorId },
              { vendorName: { equals: changes.vendorName, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
        });
        if (!candidates.some((candidate) => candidate.id === vendorId)) {
          return { outcome: 'vendor_not_found' };
        }
        if (candidates.some((candidate) => candidate.id !== vendorId)) {
          return { outcome: 'vendor_name_taken' };
        }
      }
      try {
        const row = await prismaClient.vendor.update({
          where: { id: vendorId, tenantId },
          data: {
            ...changes,
            category: changes.category && PRISMA_ENUM_BY_VENDOR_CATEGORY[changes.category],
          },
          select: VENDOR_SELECT,
        });
        return { outcome: 'updated', vendor: toVendor(row) };
      } catch (error) {
        if (isRecordNotFound(error)) return { outcome: 'vendor_not_found' };
        if (isUniqueViolation(error)) return { outcome: 'vendor_name_taken' };
        throw error;
      }
    },

    async addContact(tenantId, vendorId, contact) {
      try {
        // Written through the parent so the one statement checks the vendor is in the tenant,
        // inserts the contact and returns the vendor with all its contacts.
        const row = await prismaClient.vendor.update({
          where: { id: vendorId, tenantId },
          data: { contacts: { create: { tenantId, ...contact } } },
          select: VENDOR_SELECT,
        });
        return { outcome: 'added', vendor: toVendor(row) };
      } catch (error) {
        if (isRecordNotFound(error)) return { outcome: 'vendor_not_found' };
        if (isUniqueViolation(error)) return { outcome: 'contact_email_taken' };
        throw error;
      }
    },

    async updateContact(tenantId, vendorId, contactId, changes) {
      try {
        const row = await prismaClient.vendor.update({
          where: { id: vendorId, tenantId },
          data: { contacts: { update: { where: { id: contactId }, data: changes } } },
          select: VENDOR_SELECT,
        });
        return { outcome: 'updated', vendor: toVendor(row) };
      } catch (error) {
        // Either the vendor is not in the tenant or the contact is not under that vendor.
        if (isRecordNotFound(error)) return { outcome: 'contact_not_found' };
        if (isUniqueViolation(error)) return { outcome: 'contact_email_taken' };
        throw error;
      }
    },
  };
}

/** Prisma's code for a unique-index violation. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Prisma's code for an update whose `where` matched no row (the vendor, or the nested contact). */
function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
