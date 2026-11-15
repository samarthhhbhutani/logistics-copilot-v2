import { describe, expect, it } from 'vitest';
import type { VendorResponse } from '@lc/contract';
import {
  categoriesOfRecipients,
  recipientsError,
  selectableVendorsByCategory,
  toRfqRecipients,
} from './rfqRecipients.js';

const timestamps = { createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
const contact = (id: string, active = true) => ({
  id,
  contactName: `Person ${id}`,
  emailAddress: `${id}@example.com`,
  phoneNumber: null,
  active,
  ...timestamps,
});
const vendors: VendorResponse[] = [
  {
    id: 'v-carrier',
    vendorName: 'Blue Line',
    category: 'carrier',
    notes: null,
    active: true,
    contacts: [contact('c1'), contact('c2', false)],
    ...timestamps,
  },
  {
    id: 'v-cha',
    vendorName: 'Clear Customs',
    category: 'cha',
    notes: null,
    active: true,
    contacts: [contact('c3'), contact('c4')],
    ...timestamps,
  },
  {
    id: 'v-archived',
    vendorName: 'Gone',
    category: 'cha',
    notes: null,
    active: false,
    contacts: [contact('c5')],
    ...timestamps,
  },
  {
    id: 'v-nobody',
    vendorName: 'No people',
    category: 'carrier',
    notes: null,
    active: true,
    contacts: [contact('c6', false)],
    ...timestamps,
  },
];

describe('selectableVendorsByCategory', () => {
  it('drops archived vendors, archived contacts and vendors left with nobody', () => {
    const byCategory = selectableVendorsByCategory(vendors);
    expect(byCategory.carrier.map((vendor) => vendor.id)).toEqual(['v-carrier']);
    expect(byCategory.carrier[0]!.contacts.map((c) => c.id)).toEqual(['c1']);
    expect(byCategory.cha.map((vendor) => vendor.id)).toEqual(['v-cha']);
  });
});

describe('toRfqRecipients', () => {
  it('groups ticked contacts under their vendor and leaves out vendors with no tick', () => {
    expect(toRfqRecipients(vendors, new Set(['c1', 'c4', 'unknown']))).toEqual([
      { vendorId: 'v-carrier', contactIds: ['c1'] },
      { vendorId: 'v-cha', contactIds: ['c4'] },
    ]);
  });
});

describe('categoriesOfRecipients', () => {
  it('lists the categories in form order, each once', () => {
    expect(
      categoriesOfRecipients(vendors, [
        { vendorId: 'v-cha', contactIds: ['c3'] },
        { vendorId: 'v-carrier', contactIds: ['c1'] },
      ]),
    ).toEqual(['cha', 'carrier']);
    expect(categoriesOfRecipients(vendors, [{ vendorId: 'v-cha', contactIds: ['c3'] }])).toEqual([
      'cha',
    ]);
  });
});

describe('recipientsError', () => {
  it('requires one contact and applies the contract caps', () => {
    expect(recipientsError([])).toBe('Tick at least one vendor contact.');
    expect(recipientsError([{ vendorId: 'v', contactIds: ['c'] }])).toBeNull();
    const manyVendors = Array.from({ length: 21 }, (_, i) => ({
      vendorId: `v${i}`,
      contactIds: [`c${i}`],
    }));
    expect(recipientsError(manyVendors)).toBe('At most 20 vendors per request.');
    const manyContacts = Array.from({ length: 2 }, (_, i) => ({
      vendorId: `v${i}`,
      contactIds: Array.from({ length: 51 }, (_, j) => `c${i}-${j}`),
    }));
    expect(recipientsError(manyContacts)).toBe('At most 100 contacts per request.');
  });
});
