import { describe, expect, it } from 'vitest';
import {
  MAX_CONTACTS_PER_RFQ,
  MAX_VENDORS_PER_RFQ,
  draftRfqMailsBodySchema,
  rfqDetailsSchema,
  sendRfqBodySchema,
} from './index.js';

describe('rfqDetailsSchema', () => {
  it('needs only the two ports and fills every other field with null or an empty list', () => {
    expect(rfqDetailsSchema.parse({ originPort: ' Mundra ', destinationPort: 'Tema' })).toEqual({
      originPort: 'Mundra',
      destinationPort: 'Tema',
      senderAddress: null,
      receiverAddress: null,
      mode: null,
      containers: [],
      commodity: null,
      grossWeightKg: null,
      volumeCbm: null,
      incoterm: null,
      readyDate: null,
      specialInstructions: null,
    });
  });

  it('keeps a complete request, upper-casing the incoterm and trimming text', () => {
    const parsed = rfqDetailsSchema.parse({
      originPort: 'Nhava Sheva',
      destinationPort: 'Rotterdam',
      senderAddress: ' Plot 12, GIDC Estate, Morbi 363642 ',
      receiverAddress: null,
      mode: 'sea_freight',
      containers: [
        { type: '40ft HC', quantity: 2 },
        { type: '45ft reefer', quantity: 1 },
      ],
      commodity: ' granite slabs ',
      grossWeightKg: 52000,
      volumeCbm: null,
      incoterm: 'exw',
      readyDate: 'end of November',
      specialInstructions: '',
    });
    expect(parsed.commodity).toBe('granite slabs');
    expect(parsed.incoterm).toBe('EXW');
    expect(parsed.senderAddress).toBe('Plot 12, GIDC Estate, Morbi 363642');
    expect(parsed.containers).toHaveLength(2);
    expect(parsed.specialInstructions).toBeNull();
  });

  it('rejects a blank port, a non-positive weight, a zero container count and an unknown mode', () => {
    const base = { originPort: 'Mundra', destinationPort: 'Tema' };
    expect(rfqDetailsSchema.safeParse({ ...base, originPort: '  ' }).success).toBe(false);
    expect(rfqDetailsSchema.safeParse({ ...base, grossWeightKg: 0 }).success).toBe(false);
    expect(
      rfqDetailsSchema.safeParse({ ...base, containers: [{ type: '20ft', quantity: 0 }] }).success,
    ).toBe(false);
    expect(rfqDetailsSchema.safeParse({ ...base, mode: 'rail' }).success).toBe(false);
  });
});

describe('draftRfqMailsBodySchema', () => {
  const base = {
    sourceEmailId: '00000000-0000-4000-8000-000000000001',
    details: { originPort: 'Hazira', destinationPort: 'Jebel Ali' },
    vendorIds: ['00000000-0000-4000-8000-00000000000a'],
  };

  it('accepts a minimal body and normalises the details', () => {
    const parsed = draftRfqMailsBodySchema.parse(base);
    expect(parsed.details.containers).toEqual([]);
    expect(parsed.details.incoterm).toBeNull();
  });

  it('rejects no vendors, repeated vendors and more than the cap', () => {
    expect(draftRfqMailsBodySchema.safeParse({ ...base, vendorIds: [] }).success).toBe(false);
    expect(
      draftRfqMailsBodySchema.safeParse({
        ...base,
        vendorIds: [base.vendorIds[0], base.vendorIds[0]],
      }).success,
    ).toBe(false);
    const tooMany = Array.from(
      { length: MAX_VENDORS_PER_RFQ + 1 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(draftRfqMailsBodySchema.safeParse({ ...base, vendorIds: tooMany }).success).toBe(false);
  });
});

describe('sendRfqBodySchema', () => {
  const vendorId = '00000000-0000-4000-8000-00000000000a';
  const contactId = '00000000-0000-4000-8000-0000000000c1';
  const base = {
    sourceEmailId: '00000000-0000-4000-8000-000000000001',
    details: { originPort: 'Hazira', destinationPort: 'Jebel Ali', incoterm: 'fob' },
    recipients: [{ vendorId, contactIds: [contactId] }],
    mails: [{ category: 'carrier', subject: ' RFQ: Hazira to Jebel Ali ', bodyText: 'Dear Team,' }],
  };

  it('accepts one vendor with one contact and one text, trimming the text', () => {
    const parsed = sendRfqBodySchema.parse(base);
    expect(parsed.details.incoterm).toBe('FOB');
    expect(parsed.mails[0]!.subject).toBe('RFQ: Hazira to Jebel Ali');
  });

  it('rejects a vendor without contacts, repeated contacts, repeated vendors and two texts for one category', () => {
    expect(
      sendRfqBodySchema.safeParse({ ...base, recipients: [{ vendorId, contactIds: [] }] }).success,
    ).toBe(false);
    expect(
      sendRfqBodySchema.safeParse({
        ...base,
        recipients: [{ vendorId, contactIds: [contactId, contactId] }],
      }).success,
    ).toBe(false);
    expect(
      sendRfqBodySchema.safeParse({
        ...base,
        recipients: [base.recipients[0], base.recipients[0]],
      }).success,
    ).toBe(false);
    expect(
      sendRfqBodySchema.safeParse({ ...base, mails: [base.mails[0], base.mails[0]] }).success,
    ).toBe(false);
  });

  it('rejects blank text and more contacts than the cap', () => {
    expect(
      sendRfqBodySchema.safeParse({ ...base, mails: [{ ...base.mails[0], bodyText: '  ' }] })
        .success,
    ).toBe(false);
    const tooMany = Array.from(
      { length: MAX_CONTACTS_PER_RFQ + 1 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(
      sendRfqBodySchema.safeParse({ ...base, recipients: [{ vendorId, contactIds: tooMany }] })
        .success,
    ).toBe(false);
  });
});
