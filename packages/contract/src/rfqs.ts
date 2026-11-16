import { z } from 'zod';
import { currentClassificationSchema } from './emails.js';
import { sentMailResponseSchema } from './sentMails.js';
import { vendorCategorySchema } from './vendors.js';

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

export const MAX_VENDORS_PER_RFQ = 20;

/**
 * POST /v1/mailbox/rfqs/drafts: write the vendor mails for the operator to edit on the page. Nothing
 * is stored or sent. `details` is the corrected form (ground truth); the source mail is context.
 * 404 vendor_not_found for an id outside the tenant or archived; 404 email_not_found; 503
 * drafts_unavailable when the LLM is off or down; 422 drafts_failed when it could not write.
 */
export const draftRfqMailsBodySchema = z.object({
  sourceEmailId: z.uuid(),
  details: rfqDetailsSchema,
  vendorIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_VENDORS_PER_RFQ)
    .refine((ids) => new Set(ids).size === ids.length, 'vendorIds must be distinct'),
});
export type DraftRfqMailsBody = z.input<typeof draftRfqMailsBodySchema>;

/** One draft per vendor category among the selected vendors; every contact of that category gets the edited text. */
export const rfqMailDraftResponseSchema = z.object({
  category: vendorCategorySchema,
  subject: z.string(),
  bodyText: z.string(),
  model: z.string(),
  promptVersion: z.string(),
});
export type RfqMailDraftResponse = z.infer<typeof rfqMailDraftResponseSchema>;

export const draftRfqMailsResponseSchema = z.object({
  drafts: z.array(rfqMailDraftResponseSchema),
});
export type DraftRfqMailsResponse = z.infer<typeof draftRfqMailsResponseSchema>;

export const MAX_CONTACTS_PER_RFQ = 100;
export const MAX_RFQ_MAIL_SUBJECT_LENGTH = 200;
export const MAX_RFQ_MAIL_BODY_LENGTH = 20_000;

const distinct = (values: string[]) => new Set(values).size === values.length;

/** One vendor and the people there the RFQ goes to; every contact gets their own mail and thread. */
export const rfqRecipientSchema = z.object({
  vendorId: z.uuid(),
  contactIds: z.array(z.uuid()).min(1).refine(distinct, 'contactIds must be distinct'),
});
export type RfqRecipient = z.infer<typeof rfqRecipientSchema>;

/** The operator's final text for one vendor category, after editing the draft (or writing it by hand). */
export const rfqMailTextSchema = z.object({
  category: vendorCategorySchema,
  subject: z.string().trim().min(1).max(MAX_RFQ_MAIL_SUBJECT_LENGTH),
  bodyText: z.string().trim().min(1).max(MAX_RFQ_MAIL_BODY_LENGTH),
});
export type RfqMailText = z.infer<typeof rfqMailTextSchema>;

/**
 * PUT /v1/mailbox/rfqs/:rfqId/send: create the RFQ and send one mail per contact. `rfqId` is minted by
 * the client (crypto.randomUUID) and is the idempotency key: the same PUT again sends only the mails
 * still pending or failed and reports the rest as they are, and a contact added to `recipients` on
 * a later call gets a mail then. Every recipient vendor's category needs an entry in `mails`.
 *   200 SendRfqResponse (rfq + one sent mail per contact, each with its own status)
 *   400 missing_mail_text (a recipient's category has no text) | invalid_body
 *   404 email_not_found | vendor_not_found (unknown or archived) | contact_not_found (unknown, archived
 *       or not of that vendor)
 *   409 rfq_id_taken (id used by another mailbox, or with another source mail) | mailbox_not_connected |
 *       google_client_not_configured
 */
export const sendRfqBodySchema = z.object({
  sourceEmailId: z.uuid(),
  details: rfqDetailsSchema,
  recipients: z
    .array(rfqRecipientSchema)
    .min(1)
    .max(MAX_VENDORS_PER_RFQ)
    .refine(
      (recipients) => distinct(recipients.map((recipient) => recipient.vendorId)),
      'recipient vendorIds must be distinct',
    )
    .refine(
      (recipients) =>
        recipients.flatMap((recipient) => recipient.contactIds).length <= MAX_CONTACTS_PER_RFQ,
      `at most ${MAX_CONTACTS_PER_RFQ} contacts per RFQ`,
    ),
  mails: z
    .array(rfqMailTextSchema)
    .min(1)
    .refine((mails) => distinct(mails.map((mail) => mail.category)), 'one text per category'),
});
export type SendRfqBody = z.input<typeof sendRfqBodySchema>;

/**
 * The newest inbound mail a vendor sent back to one RFQ mail of ours: enough for a row on the RFQ
 * page without loading the thread. The thread itself comes from GET threads/:threadId with the RFQ
 * mail's gmailThreadId once the operator expands the row.
 */
export const rfqLatestReplySchema = z.object({
  emailId: z.uuid(),
  sender: z.object({ name: z.string(), email: z.string().nullable() }),
  receivedAt: z.iso.datetime(),
  snippet: z.string(),
  /** vendor_quote when the processor read a price in it, vendor_reply otherwise; null until classified. */
  classification: currentClassificationSchema.nullable(),
});
export type RfqLatestReplyResponse = z.infer<typeof rfqLatestReplySchema>;

/** The inbound mails the processor linked to this RFQ mail (emails.answers_sent_mail_id). */
export const rfqMailRepliesSchema = z.object({
  count: z.number().int().nonnegative(),
  /** Newest by receivedAt; null until the vendor answers. */
  latest: rfqLatestReplySchema.nullable(),
});
export type RfqMailRepliesResponse = z.infer<typeof rfqMailRepliesSchema>;

/** One vendor mail of an RFQ together with what came back for it. */
export const rfqMailWithRepliesResponseSchema = sentMailResponseSchema.extend({
  replies: rfqMailRepliesSchema,
});
export type RfqMailWithRepliesResponse = z.infer<typeof rfqMailWithRepliesResponseSchema>;

/** An RFQ with every mail it produced, one per contact, oldest first. */
export const rfqWithMailsResponseSchema = z.object({
  rfq: rfqResponseSchema,
  /** Status sent | failed | pending (not reached this time) | sending (outcome unknown, resolved later by the sweeper). */
  mails: z.array(rfqMailWithRepliesResponseSchema),
});
export type RfqWithMailsResponse = z.infer<typeof rfqWithMailsResponseSchema>;

export const sendRfqResponseSchema = rfqWithMailsResponseSchema;
export type SendRfqResponse = RfqWithMailsResponse;

/**
 * GET /v1/mailbox/rfqs/:rfqId: the RFQ and its mails as they stand now, each with the replies it
 * has drawn. The client polls this while a mail is still `sending`, to see the sweeper resolve it.
 *   200 RfqWithMailsResponse
 *   404 rfq_not_found (unknown, or of another mailbox or tenant)
 */
export const getRfqResponseSchema = rfqWithMailsResponseSchema;
