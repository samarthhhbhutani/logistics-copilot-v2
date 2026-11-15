import { rfqDetailsSchema } from '@lc/contract';
import type { FreightMode, RfqDetails, RfqDetailsInput, RfqSuggestionResponse } from '@lc/contract';

/** One row of the containers table; quantity stays text until the form is parsed. */
export interface ContainerRowValues {
  type: string;
  quantity: string;
}

/**
 * The RFQ form as the inputs hold it: every field a string (or '' for "not stated") so a half-typed
 * number is never lost to a NaN. `parseRfqDetailsForm` turns it into the contract's `RfqDetails`.
 */
export interface RfqDetailsFormValues {
  originPort: string;
  destinationPort: string;
  senderAddress: string;
  receiverAddress: string;
  mode: FreightMode | '';
  containers: ContainerRowValues[];
  commodity: string;
  grossWeightKg: string;
  volumeCbm: string;
  incoterm: string;
  readyDate: string;
  specialInstructions: string;
}

export type RfqDetailsField = keyof RfqDetailsFormValues;

export const EMPTY_RFQ_DETAILS_FORM: RfqDetailsFormValues = {
  originPort: '',
  destinationPort: '',
  senderAddress: '',
  receiverAddress: '',
  mode: '',
  containers: [],
  commodity: '',
  grossWeightKg: '',
  volumeCbm: '',
  incoterm: '',
  readyDate: '',
  specialInstructions: '',
};

export const rfqDetailsFieldLabels: Record<RfqDetailsField, string> = {
  originPort: 'Origin port',
  destinationPort: 'Destination port',
  senderAddress: 'Pickup address',
  receiverAddress: 'Delivery address',
  mode: 'Mode',
  containers: 'Containers',
  commodity: 'Commodity',
  grossWeightKg: 'Gross weight (kg)',
  volumeCbm: 'Volume (cbm)',
  incoterm: 'Incoterm',
  readyDate: 'Cargo ready',
  specialInstructions: 'Special instructions',
};

export const freightModeTitles: Record<FreightMode, string> = {
  sea_freight: 'Sea freight',
  air_freight: 'Air freight',
  road: 'Road',
};

/** Prefill from the model's reading of the mail; a null becomes an empty input the operator fills. */
export function rfqDetailsFormFromSuggestion(
  suggestion: RfqSuggestionResponse,
): RfqDetailsFormValues {
  return {
    originPort: suggestion.originPort ?? '',
    destinationPort: suggestion.destinationPort ?? '',
    senderAddress: suggestion.senderAddress ?? '',
    receiverAddress: suggestion.receiverAddress ?? '',
    mode: suggestion.mode ?? '',
    containers: suggestion.containers.map((container) => ({
      type: container.type,
      quantity: String(container.quantity),
    })),
    commodity: suggestion.commodity ?? '',
    grossWeightKg: suggestion.grossWeightKg === null ? '' : String(suggestion.grossWeightKg),
    volumeCbm: suggestion.volumeCbm === null ? '' : String(suggestion.volumeCbm),
    incoterm: suggestion.incoterm ?? '',
    readyDate: suggestion.readyDate ?? '',
    specialInstructions: suggestion.specialInstructions ?? '',
  };
}

export type RfqDetailsFormErrors = Partial<Record<RfqDetailsField, string>>;

export type RfqDetailsFormResult =
  { ok: true; details: RfqDetails } | { ok: false; errors: RfqDetailsFormErrors };

/**
 * Validate with the same schema the API applies, so the form can never accept what the send would
 * reject. One message per field, the first issue wins; nested container issues land on `containers`.
 */
export function parseRfqDetailsForm(values: RfqDetailsFormValues): RfqDetailsFormResult {
  const parsed = rfqDetailsSchema.safeParse(toRfqDetailsInput(values));
  if (parsed.success) return { ok: true, details: parsed.data };
  const errors: RfqDetailsFormErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field !== 'string' || !(field in rfqDetailsFieldLabels)) continue;
    const key = field as RfqDetailsField;
    errors[key] ??= fieldErrorMessage(key, values, issue.path);
  }
  return { ok: false, errors };
}

function toRfqDetailsInput(values: RfqDetailsFormValues): RfqDetailsInput {
  return {
    originPort: values.originPort,
    destinationPort: values.destinationPort,
    senderAddress: values.senderAddress,
    receiverAddress: values.receiverAddress,
    mode: values.mode || null,
    containers: values.containers.map((container) => ({
      type: container.type,
      quantity: numberOrNaN(container.quantity),
    })),
    commodity: values.commodity,
    grossWeightKg: optionalNumber(values.grossWeightKg),
    volumeCbm: optionalNumber(values.volumeCbm),
    incoterm: values.incoterm,
    readyDate: values.readyDate,
    specialInstructions: values.specialInstructions,
  };
}

/** '' means "not stated"; anything else must be a number, and NaN lets the schema name the field. */
function optionalNumber(text: string): number | null {
  return text.trim() === '' ? null : numberOrNaN(text);
}

function numberOrNaN(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

function fieldErrorMessage(
  field: RfqDetailsField,
  values: RfqDetailsFormValues,
  path: PropertyKey[],
): string {
  const label = rfqDetailsFieldLabels[field];
  switch (field) {
    case 'originPort':
    case 'destinationPort':
      return values[field].trim() === '' ? `${label} is required.` : `${label} is too long.`;
    case 'grossWeightKg':
    case 'volumeCbm':
      return `${label} must be a number above zero.`;
    case 'containers': {
      const row = typeof path[1] === 'number' ? `Container ${path[1] + 1}` : 'A container';
      if (path[2] === 'quantity') return `${row} needs a quantity from 1 to 99.`;
      if (path[2] === 'type') return `${row} needs a type.`;
      return 'At most 20 container rows.';
    }
    default:
      return `${label} is too long.`;
  }
}
