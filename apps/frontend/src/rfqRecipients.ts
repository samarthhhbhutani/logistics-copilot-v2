import { MAX_CONTACTS_PER_RFQ, MAX_VENDORS_PER_RFQ } from '@lc/contract';
import type { RfqRecipient, VendorCategory, VendorResponse } from '@lc/contract';

export const vendorCategoryTitles: Record<VendorCategory, string> = {
  cha: 'Customs house agents',
  carrier: 'Carriers',
};

/** The order the categories are listed in on the form. */
export const VENDOR_CATEGORIES: VendorCategory[] = ['cha', 'carrier'];

/** Active vendors with at least one active contact, in list order, keyed by category for the picker. */
export function selectableVendorsByCategory(
  vendors: VendorResponse[],
): Record<VendorCategory, VendorResponse[]> {
  const byCategory: Record<VendorCategory, VendorResponse[]> = { cha: [], carrier: [] };
  for (const vendor of vendors) {
    if (!vendor.active) continue;
    const contacts = vendor.contacts.filter((contact) => contact.active);
    if (contacts.length === 0) continue;
    byCategory[vendor.category].push({ ...vendor, contacts });
  }
  return byCategory;
}

/** The ticked contacts folded into the contract's one-entry-per-vendor shape, empty vendors dropped. */
export function toRfqRecipients(
  vendors: VendorResponse[],
  selectedContactIds: ReadonlySet<string>,
): RfqRecipient[] {
  const recipients: RfqRecipient[] = [];
  for (const vendor of vendors) {
    const contactIds = vendor.contacts
      .filter((contact) => selectedContactIds.has(contact.id))
      .map((contact) => contact.id);
    if (contactIds.length > 0) recipients.push({ vendorId: vendor.id, contactIds });
  }
  return recipients;
}

/** The categories the drafts must cover: one mail text per category among the chosen vendors. */
export function categoriesOfRecipients(
  vendors: VendorResponse[],
  recipients: RfqRecipient[],
): VendorCategory[] {
  const chosen = new Set(recipients.map((recipient) => recipient.vendorId));
  const categories = new Set(
    vendors.filter((vendor) => chosen.has(vendor.id)).map((vendor) => vendor.category),
  );
  return VENDOR_CATEGORIES.filter((category) => categories.has(category));
}

/** Null when the selection can be sent; otherwise the one message the form shows under the picker. */
export function recipientsError(recipients: RfqRecipient[]): string | null {
  if (recipients.length === 0) return 'Tick at least one vendor contact.';
  if (recipients.length > MAX_VENDORS_PER_RFQ)
    return `At most ${MAX_VENDORS_PER_RFQ} vendors per request.`;
  const contactCount = recipients.reduce((sum, recipient) => sum + recipient.contactIds.length, 0);
  if (contactCount > MAX_CONTACTS_PER_RFQ)
    return `At most ${MAX_CONTACTS_PER_RFQ} contacts per request.`;
  return null;
}
