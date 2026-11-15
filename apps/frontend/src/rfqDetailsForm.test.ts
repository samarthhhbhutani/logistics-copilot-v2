import { describe, expect, it } from 'vitest';
import type { RfqSuggestionResponse } from '@lc/contract';
import {
  EMPTY_RFQ_DETAILS_FORM,
  parseRfqDetailsForm,
  rfqDetailsFormFromSuggestion,
} from './rfqDetailsForm.js';

const suggestion: RfqSuggestionResponse = {
  originPort: 'Nhava Sheva',
  destinationPort: null,
  senderAddress: null,
  receiverAddress: 'Hamburg warehouse',
  mode: 'sea_freight',
  containers: [{ type: '40ft HC', quantity: 2 }],
  commodity: 'Auto parts',
  grossWeightKg: 18000,
  volumeCbm: null,
  incoterm: 'fob',
  readyDate: 'end of November',
  specialInstructions: null,
  model: 'test-model',
  promptVersion: 'v1',
};

describe('rfqDetailsFormFromSuggestion', () => {
  it('turns every null into an empty input and numbers into text', () => {
    expect(rfqDetailsFormFromSuggestion(suggestion)).toEqual({
      originPort: 'Nhava Sheva',
      destinationPort: '',
      senderAddress: '',
      receiverAddress: 'Hamburg warehouse',
      mode: 'sea_freight',
      containers: [{ type: '40ft HC', quantity: '2' }],
      commodity: 'Auto parts',
      grossWeightKg: '18000',
      volumeCbm: '',
      incoterm: 'fob',
      readyDate: 'end of November',
      specialInstructions: '',
    });
  });
});

describe('parseRfqDetailsForm', () => {
  it('produces the contract details: numbers parsed, incoterm upper-cased, blanks null', () => {
    const result = parseRfqDetailsForm({
      ...rfqDetailsFormFromSuggestion(suggestion),
      destinationPort: ' Hamburg ',
      volumeCbm: ' ',
    });
    expect(result).toEqual({
      ok: true,
      details: {
        originPort: 'Nhava Sheva',
        destinationPort: 'Hamburg',
        senderAddress: null,
        receiverAddress: 'Hamburg warehouse',
        mode: 'sea_freight',
        containers: [{ type: '40ft HC', quantity: 2 }],
        commodity: 'Auto parts',
        grossWeightKg: 18000,
        volumeCbm: null,
        incoterm: 'FOB',
        readyDate: 'end of November',
        specialInstructions: null,
      },
    });
  });

  it('names the required ports and rejects text where a number is expected', () => {
    const result = parseRfqDetailsForm({
      ...EMPTY_RFQ_DETAILS_FORM,
      originPort: '   ',
      grossWeightKg: 'heavy',
      volumeCbm: '-3',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        originPort: 'Origin port is required.',
        destinationPort: 'Destination port is required.',
        grossWeightKg: 'Gross weight (kg) must be a number above zero.',
        volumeCbm: 'Volume (cbm) must be a number above zero.',
      },
    });
  });

  it('points at the container row that is incomplete', () => {
    const result = parseRfqDetailsForm({
      ...EMPTY_RFQ_DETAILS_FORM,
      originPort: 'A',
      destinationPort: 'B',
      containers: [
        { type: '20ft', quantity: '1' },
        { type: '', quantity: '' },
      ],
    });
    expect(result).toEqual({
      ok: false,
      errors: { containers: 'Container 2 needs a type.' },
    });
  });

  it('keeps an empty containers list and an unspecified mode', () => {
    const result = parseRfqDetailsForm({
      ...EMPTY_RFQ_DETAILS_FORM,
      originPort: 'A',
      destinationPort: 'B',
    });
    expect(result.ok && result.details.containers).toEqual([]);
    expect(result.ok && result.details.mode).toBeNull();
  });
});
