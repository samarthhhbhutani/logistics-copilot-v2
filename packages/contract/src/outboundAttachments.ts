import { z } from 'zod';

/** One file; Gmail takes 25 MB per mail, so this leaves room for the body, signature images and encoding overhead. */
export const OUTBOUND_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Per outgoing mail (every mail of an RFQ carries the whole set), enforced at the send and in the composer. */
export const OUTBOUND_ATTACHMENTS_MAX_PER_MAIL = 10;
export const OUTBOUND_ATTACHMENTS_MAX_TOTAL_BYTES = 18 * 1024 * 1024;
export const OUTBOUND_ATTACHMENT_FILE_NAME_MAX_LENGTH = 200;

/**
 * Extensions Gmail refuses to send (support.google.com/mail/answer/6590), also inside archives.
 * Checked on upload so the operator hears about it when picking the file, not when sending.
 */
export const GMAIL_BLOCKED_EXTENSIONS = [
  'ade',
  'adp',
  'apk',
  'appx',
  'appxbundle',
  'bat',
  'cab',
  'chm',
  'cmd',
  'com',
  'cpl',
  'diagcab',
  'diagcfg',
  'diagpack',
  'dll',
  'dmg',
  'ex',
  'ex_',
  'exe',
  'hta',
  'img',
  'ins',
  'iso',
  'isp',
  'jar',
  'jnlp',
  'js',
  'jse',
  'lib',
  'lnk',
  'mde',
  'msc',
  'msi',
  'msix',
  'msixbundle',
  'msp',
  'mst',
  'nsh',
  'pif',
  'ps1',
  'scr',
  'sct',
  'shb',
  'sys',
  'vb',
  'vbe',
  'vbs',
  'vhd',
  'vxd',
  'wsc',
  'wsf',
  'wsh',
  'xll',
] as const;

/** The lower-cased extension of a file name without its dot; undefined when there is none. */
export function fileNameExtension(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return undefined;
  return fileName.slice(dot + 1).toLowerCase();
}

export function isGmailBlockedExtension(extension: string): boolean {
  return (GMAIL_BLOCKED_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
}

export function hasGmailBlockedExtension(fileName: string): boolean {
  const extension = fileNameExtension(fileName);
  return extension !== undefined && isGmailBlockedExtension(extension);
}

/** A file waiting in the composer or carried by a sent mail. */
export const outboundAttachmentResponseSchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type OutboundAttachmentResponse = z.infer<typeof outboundAttachmentResponseSchema>;

/**
 * POST /v1/mailbox/outbound-attachments?fileName=: the body is the raw file bytes with its Content-Type
 * (any type; the stored type is what the bytes are when that can be told, else the declared one,
 * else application/octet-stream). 201 OutboundAttachmentResponse. 400 empty_attachment, 413
 * attachment_too_large, 415 blocked_file_type (Gmail would refuse it), 503
 * outbound_attachments_unavailable (no bucket configured). The upload is not yet on any mail: the
 * send names it by id.
 */
export const uploadOutboundAttachmentQuerySchema = z.object({
  fileName: z.string().trim().min(1).max(OUTBOUND_ATTACHMENT_FILE_NAME_MAX_LENGTH),
});

/** DELETE /v1/mailbox/outbound-attachments/:attachmentId. 204; 404 not_found, also once a sent mail carries it. */
