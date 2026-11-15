import { z } from 'zod';

export const MAX_PORT_LENGTH = 200;
export const MAX_COMMODITY_LENGTH = 500;
export const MAX_INCOTERM_LENGTH = 20;
export const MAX_READY_DATE_LENGTH = 100;
export const MAX_ADDRESS_LENGTH = 500;
export const MAX_SPECIAL_INSTRUCTIONS_LENGTH = 2000;
export const MAX_CONTAINER_TYPE_LENGTH = 60;
export const MAX_CONTAINERS_PER_RFQ = 20;
export const MAX_CONTAINER_QUANTITY = 99;

/** Boxes the form offers as ticks; the type is still free text so "45ft reefer" can be typed. */
export const SUGGESTED_CONTAINER_TYPES = ['20ft', '40ft', '40ft HC'] as const;

export const freightModeSchema = z.enum(['sea_freight', 'air_freight', 'road']);
export type FreightMode = z.infer<typeof freightModeSchema>;

/** Optional free text: absent, null, empty or blank all become null. */
const optionalText = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));

/** Optional positive measurement: absent or null when the request did not state it. */
const optionalMeasurement = () =>
  z
    .number()
    .positive()
    .finite()
    .nullable()
    .optional()
    .transform((value) => value ?? null);

export const containerRequestSchema = z.object({
  type: z.string().trim().min(1).max(MAX_CONTAINER_TYPE_LENGTH),
  quantity: z.number().int().min(1).max(MAX_CONTAINER_QUANTITY),
});
export type ContainerRequest = z.infer<typeof containerRequestSchema>;

/**
 * What the desk knows about a shipment when it asks vendors for rates: what the LLM suggests from
 * the customer mail, what the operator corrects on the form, and what the drafting agent is given
 * as ground truth. The same shape travels through suggestion, drafting and sending, so the three
 * can never disagree about a field. Only the ports are required; everything else is null when the
 * request did not say. Not stored as columns: it lives on in the mails it produced.
 */
export const rfqDetailsSchema = z.object({
  originPort: z.string().trim().min(1).max(MAX_PORT_LENGTH),
  destinationPort: z.string().trim().min(1).max(MAX_PORT_LENGTH),
  /** Where the cargo is collected, when the rate must include that leg (EXW, FCA at the works). */
  senderAddress: optionalText(MAX_ADDRESS_LENGTH),
  /** Where the cargo is delivered beyond the port (DAP, DDP). */
  receiverAddress: optionalText(MAX_ADDRESS_LENGTH),
  mode: freightModeSchema
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  containers: z.array(containerRequestSchema).max(MAX_CONTAINERS_PER_RFQ).default([]),
  commodity: optionalText(MAX_COMMODITY_LENGTH),
  grossWeightKg: optionalMeasurement(),
  /** Cubic metres; what LCL and air freight are priced on. Null for a full-container request. */
  volumeCbm: optionalMeasurement(),
  /** Upper-cased on the way in (FOB, CIF, EXW, ...); free text because the list keeps growing. */
  incoterm: optionalText(MAX_INCOTERM_LENGTH).transform((value) => value?.toUpperCase() ?? null),
  /** Kept as the request phrased it ("end of November", "20 Nov"); never parsed into a date. */
  readyDate: optionalText(MAX_READY_DATE_LENGTH),
  specialInstructions: optionalText(MAX_SPECIAL_INSTRUCTIONS_LENGTH),
});
export type RfqDetailsInput = z.input<typeof rfqDetailsSchema>;
export type RfqDetails = z.output<typeof rfqDetailsSchema>;

/** open: sent to vendors, quotes may still arrive. closed: the operator is done with it. */
export const rfqStatusSchema = z.enum(['open', 'closed']);
export type RfqStatus = z.infer<typeof rfqStatusSchema>;

/** One RFQ as the list and summary pages read it; the vendor mails come from sent_mails by rfqId. */
export const rfqResponseSchema = z.object({
  id: z.uuid(),
  sourceEmailId: z.uuid(),
  originPort: z.string(),
  destinationPort: z.string(),
  incoterm: z.string().nullable(),
  status: rfqStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RfqResponse = z.infer<typeof rfqResponseSchema>;

/**
 * POST /v1/mailbox/emails/:emailId/rfq-suggestion: the shipment details an LLM read out of the mail,
 * for the operator to correct on the form. Same keys as rfqDetails; the ports are nullable here
 * because a suggestion may not find them, and nothing is validated against the form's limits
 * (the form does that when the operator submits). 503 suggestion_unavailable when the LLM is not
 * configured or not reachable right now; 422 suggestion_failed when it could not read the mail.
 */
export const rfqSuggestionResponseSchema = z.object({
  originPort: z.string().nullable(),
  destinationPort: z.string().nullable(),
  senderAddress: z.string().nullable(),
  receiverAddress: z.string().nullable(),
  mode: freightModeSchema.nullable(),
  containers: z.array(z.object({ type: z.string(), quantity: z.number().int() })),
  commodity: z.string().nullable(),
  grossWeightKg: z.number().nullable(),
  volumeCbm: z.number().nullable(),
  incoterm: z.string().nullable(),
  readyDate: z.string().nullable(),
  specialInstructions: z.string().nullable(),
  model: z.string(),
  promptVersion: z.string(),
});
export type RfqSuggestionResponse = z.infer<typeof rfqSuggestionResponseSchema>;
