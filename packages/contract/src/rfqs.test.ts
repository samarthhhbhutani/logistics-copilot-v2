import { describe, expect, it } from 'vitest';
import { rfqDetailsSchema } from './index.js';

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
