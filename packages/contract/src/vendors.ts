import { z } from 'zod';

export const MAX_VENDOR_NAME_LENGTH = 200;
export const MAX_CONTACT_NAME_LENGTH = 200;
export const MAX_PHONE_NUMBER_LENGTH = 40;
export const MAX_VENDOR_NOTES_LENGTH = 2000;
export const MAX_CONTACTS_PER_VENDOR = 20;
export const MAX_EMAIL_ADDRESS_LENGTH = 254;

/** cha: customs house agent. carrier: shipping line, airline or trucker. */
export const vendorCategorySchema = z.enum(['cha', 'carrier']);
export type VendorCategory = z.infer<typeof vendorCategorySchema>;

/** Optional free text: an empty or blank string is stored as null. */
const optionalText = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));

export const createVendorContactBodySchema = z.object({
  contactName: z.string().trim().min(1).max(MAX_CONTACT_NAME_LENGTH),
  /** Normalised before validation: a padded or capitalised address is the same contact. */
  emailAddress: z.string().trim().toLowerCase().pipe(z.email().max(MAX_EMAIL_ADDRESS_LENGTH)),
  phoneNumber: optionalText(MAX_PHONE_NUMBER_LENGTH),
});

/**
 * POST /v1/mailbox/vendors. A vendor may be created with its people in one request or with none,
 * since the desk often knows the company before the person; contacts can be added later. Two
 * contacts in one request cannot share an address.
 */
export const createVendorBodySchema = z.object({
  vendorName: z.string().trim().min(1).max(MAX_VENDOR_NAME_LENGTH),
  category: vendorCategorySchema,
  notes: optionalText(MAX_VENDOR_NOTES_LENGTH),
  contacts: z
    .array(createVendorContactBodySchema)
    .max(MAX_CONTACTS_PER_VENDOR)
    .default([])
    .refine(
      (contacts) =>
        new Set(contacts.map((contact) => contact.emailAddress)).size === contacts.length,
      'contacts must have distinct email addresses',
    ),
});
export type CreateVendorBody = z.input<typeof createVendorBodySchema>;

/** PATCH /v1/mailbox/vendors/:vendorId. Partial; at least one field. `active: false` archives. */
export const updateVendorBodySchema = z
  .object({
    vendorName: z.string().trim().min(1).max(MAX_VENDOR_NAME_LENGTH),
    category: vendorCategorySchema,
    notes: optionalText(MAX_VENDOR_NOTES_LENGTH),
    active: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field is required');
export type UpdateVendorBody = z.input<typeof updateVendorBodySchema>;

/** PATCH /v1/mailbox/vendors/:vendorId/contacts/:contactId. Partial; at least one field. */
export const updateVendorContactBodySchema = z
  .object({
    contactName: z.string().trim().min(1).max(MAX_CONTACT_NAME_LENGTH),
    emailAddress: z.string().trim().toLowerCase().pipe(z.email().max(MAX_EMAIL_ADDRESS_LENGTH)),
    phoneNumber: optionalText(MAX_PHONE_NUMBER_LENGTH),
    active: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field is required');
export type UpdateVendorContactBody = z.input<typeof updateVendorContactBodySchema>;

export const vendorContactResponseSchema = z.object({
  id: z.uuid(),
  contactName: z.string(),
  emailAddress: z.string(),
  phoneNumber: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type VendorContactResponse = z.infer<typeof vendorContactResponseSchema>;

export const vendorResponseSchema = z.object({
  id: z.uuid(),
  vendorName: z.string(),
  category: vendorCategorySchema,
  notes: z.string().nullable(),
  active: z.boolean(),
  contacts: z.array(vendorContactResponseSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type VendorResponse = z.infer<typeof vendorResponseSchema>;

/** GET /v1/mailbox/vendors: every vendor of the session's tenant with its contacts, archived included, by name. */
export const listVendorsResponseSchema = z.object({
  vendors: z.array(vendorResponseSchema),
});
export type ListVendorsResponse = z.infer<typeof listVendorsResponseSchema>;
