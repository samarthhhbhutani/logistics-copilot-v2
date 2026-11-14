import type { VendorCategory as PrismaVendorCategory } from '../db/generated/client.js';

/** cha: customs house agent. carrier: shipping line, airline or trucker. */
export type VendorCategory = 'cha' | 'carrier';

/** A person at a vendor an RFQ can be addressed to. */
export interface VendorContact {
  id: string;
  contactName: string;
  /** Normalised by the contract schema (trimmed, lowercased); unique within the vendor. */
  emailAddress: string;
  phoneNumber: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A company the desk sends RFQs to, with the people there. Tenant-wide. */
export interface Vendor {
  id: string;
  vendorName: string;
  category: VendorCategory;
  notes: string | null;
  active: boolean;
  contacts: VendorContact[];
  createdAt: Date;
  updatedAt: Date;
}

// Prisma generates UPPER_CASE enum members; the API and the columns speak lowercase.
export const PRISMA_ENUM_BY_VENDOR_CATEGORY: Record<VendorCategory, PrismaVendorCategory> = {
  cha: 'CHA',
  carrier: 'CARRIER',
};
export const VENDOR_CATEGORY_BY_PRISMA_ENUM: Record<PrismaVendorCategory, VendorCategory> = {
  CHA: 'cha',
  CARRIER: 'carrier',
};
