import { z } from 'zod';
import {
  OUTBOUND_ATTACHMENTS_MAX_PER_MAIL,
  outboundAttachmentResponseSchema,
} from './outboundAttachments.js';
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
 * `attachmentIds` are uploads (POST /v1/mailbox/outbound-attachments) every vendor mail carries; they
 * become the RFQ's on the first call and stay with it, so a later call (retry, added contact) carries
 * the same files whether or not it repeats the ids.
 *   200 SendRfqResponse (rfq + one sent mail per contact, each with its own status)
 *   400 missing_mail_text (a recipient's category has no text) | invalid_body
 *   404 email_not_found | vendor_not_found (unknown or archived) | contact_not_found (unknown, archived
 *       or not of that vendor)
 *   409 rfq_id_taken (id used by another mailbox, or with another source mail) | mailbox_not_connected |
 *       google_client_not_configured | attachment_not_found (an id that is not this mailbox's upload) |
 *       attachment_already_sent (an upload another mail or RFQ carries)
 *   413 attachments_too_large (every vendor mail carries the whole set, so the per-mail total applies)
 *   503 outbound_attachments_unavailable (files named but no bucket configured)
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
  attachmentIds: z
    .array(z.uuid())
    .max(OUTBOUND_ATTACHMENTS_MAX_PER_MAIL)
    .refine(distinct, 'attachment ids must be unique')
    .default([]),
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
  /** The files every mail of the RFQ carries, upload order; listed once here rather than on each mail. */
  attachments: z.array(outboundAttachmentResponseSchema).default([]),
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

/**
 * GET /v1/mailbox/rfqs/bySourceEmail/:emailId: the newest RFQ sent from this customer mail, in the
 * same shape as GET /v1/mailbox/rfqs/:rfqId. A mail processed twice has two RFQs; the thread view
 * shows the latest and the RFQ list shows them all. How the thread view finds the RFQ after a reload.
 *   200 RfqWithMailsResponse
 *   404 rfq_not_found (no RFQ was sent from this mail, or the mail is of another mailbox or tenant)
 */
export const getRfqBySourceEmailResponseSchema = rfqWithMailsResponseSchema;

export const MAX_RFQ_PAGE_SIZE = 100;
export const DEFAULT_RFQ_PAGE_SIZE = 25;

/** GET /v1/mailbox/rfqs ?limit=25&cursor=<opaque> */
export const listRfqsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_RFQ_PAGE_SIZE).default(DEFAULT_RFQ_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});
export type ListRfqsQuery = z.input<typeof listRfqsQuerySchema>;

/** The customer mail an RFQ was sent from: who asked and what for, enough for a card without the body. */
export const rfqSourceEmailSchema = z.object({
  id: z.uuid(),
  sender: z.object({ name: z.string(), email: z.string().nullable() }),
  subject: z.string(),
  receivedAt: z.iso.datetime(),
});
export type RfqSourceEmailResponse = z.infer<typeof rfqSourceEmailSchema>;

/**
 * How far an RFQ has come, counted in vendors rather than messages: a vendor who writes twice is
 * one reply, and the desk's question is "how many have come back", not "how much mail arrived".
 */
export const rfqReplyCountsSchema = z.object({
  /** Contacts the RFQ reached or may still reach: every mail of the RFQ that is not `failed`. */
  contactCount: z.number().int().nonnegative(),
  /** Contacts with at least one inbound mail linked to their RFQ mail. */
  repliedCount: z.number().int().nonnegative(),
  /** Contacts whose newest reply is labelled vendor_quote. */
  quoteCount: z.number().int().nonnegative(),
});
export type RfqReplyCountsResponse = z.infer<typeof rfqReplyCountsSchema>;

/** One RFQ in the list; its mails come from GET /v1/mailbox/rfqs/:rfqId when the row is opened. */
export const rfqListItemSchema = z.object({
  rfq: rfqResponseSchema,
  replies: rfqReplyCountsSchema,
});
export type RfqListItemResponse = z.infer<typeof rfqListItemSchema>;

/** A customer mail and every RFQ sent from it on this page, newest first (a mail processed twice has two). */
export const rfqCustomerMailGroupSchema = z.object({
  sourceEmail: rfqSourceEmailSchema,
  rfqs: z.array(rfqListItemSchema).min(1),
});
export type RfqCustomerMailGroupResponse = z.infer<typeof rfqCustomerMailGroupSchema>;

/**
 * GET /v1/mailbox/rfqs: the mailbox's RFQs newest first (created_at desc), grouped under the customer
 * mail each answers. Groups come in order of first appearance, so a group sits where its newest RFQ
 * falls. The page is cut in RFQs, not groups: a customer mail whose RFQs straddle a page boundary
 * appears again on the next page, and the client merges the two groups by sourceEmail.id.
 *   200 ListRfqsResponse
 *   400 invalid_query (limit out of 1..MAX_RFQ_PAGE_SIZE) | invalid_cursor (not a cursor this API issued)
 *   401
 */
export const listRfqsResponseSchema = z.object({
  customerMails: z.array(rfqCustomerMailGroupSchema),
  /** Pass back as ?cursor= for the next page; null when this was the last page. */
  nextCursor: z.string().nullable(),
});
export type ListRfqsResponse = z.infer<typeof listRfqsResponseSchema>;
