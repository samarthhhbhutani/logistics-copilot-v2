import { z } from 'zod';

/** One file of an email as the UI lists it; no storage details and no URL (fetch one on demand). */
export const attachmentSummarySchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** True for images referenced from the HTML body (cid:), i.e. logos and signatures, not files someone attached. */
  isInline: z.boolean(),
  /** MIME Content-ID without angle brackets, matched against cid: references in the HTML body. */
  // Defaults to null so a frontend ahead of the API still parses older responses; those images just stay unresolved.
  contentId: z.string().nullable().default(null),
});
export type AttachmentSummaryResponse = z.infer<typeof attachmentSummarySchema>;

/** GET /v1/mailbox/emails/:emailId/attachments */
export const listAttachmentsResponseSchema = z.object({
  emailId: z.uuid(),
  attachments: z.array(attachmentSummarySchema),
});
export type ListAttachmentsResponse = z.infer<typeof listAttachmentsResponseSchema>;

/**
 * GET /v1/mailbox/emails/:emailId/attachments/:attachmentId/download-url
 * A short-lived link straight to storage; the browser downloads the file under its original name.
 */
export const attachmentDownloadUrlResponseSchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
export type AttachmentDownloadUrlResponse = z.infer<typeof attachmentDownloadUrlResponseSchema>;
