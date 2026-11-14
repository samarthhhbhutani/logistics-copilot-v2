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

export interface VendorRepository {
  /** Every vendor of the tenant with its contacts, archived included, by name. */
  listVendors(tenantId: string): Promise<Vendor[]>;
  /** Vendor and contacts in one transaction, so a half-created vendor never exists. */
  createVendor(tenantId: string, vendor: VendorToCreate): Promise<CreateVendorResult>;
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
      const sameName = await prismaClient.vendor.findFirst({
        where: { tenantId, vendorName: { equals: vendor.vendorName, mode: 'insensitive' } },
        select: { id: true },
      });
      if (sameName) return { outcome: 'vendor_name_taken' };
      try {
        const row = await prismaClient.vendor.create({
          data: {
            tenantId,
            vendorName: vendor.vendorName,
            category: PRISMA_ENUM_BY_VENDOR_CATEGORY[vendor.category],
            notes: vendor.notes,
            contacts: {
              create: vendor.contacts.map((contact) => ({
                tenantId,
                contactName: contact.contactName,
                emailAddress: contact.emailAddress,
                phoneNumber: contact.phoneNumber,
              })),
            },
          },
          select: VENDOR_SELECT,
        });
        return { outcome: 'created', vendor: toVendor(row) };
      } catch (error) {
        // The nested create is one statement set inside Prisma's implicit transaction, so a duplicate
        // name leaves nothing behind. Duplicate contact addresses within one request are rejected by
        // the contract schema before reaching here.
        if (isUniqueViolation(error)) return { outcome: 'vendor_name_taken' };
        throw error;
      }
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
