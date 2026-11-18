import { z } from 'zod';

/** What an uploaded signature image may be. Checked against the bytes, not just the declared type. */
export const SIGNATURE_IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif'] as const;
export type SignatureImageContentType = (typeof SIGNATURE_IMAGE_CONTENT_TYPES)[number];
/** A logo or badge, not a photo: every mail we send carries each image. */
export const SIGNATURE_IMAGE_MAX_BYTES = 200 * 1024;
export const SIGNATURE_IMAGES_MAX_PER_MAILBOX = 5;
/** The uploaded file's name travels as this query parameter on POST; optional, display only. */
export const SIGNATURE_IMAGE_FILE_NAME_MAX_LENGTH = 200;

export const signatureImageResponseSchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  contentType: z.enum(SIGNATURE_IMAGE_CONTENT_TYPES),
  sizeBytes: z.number().int().nonnegative(),
  /** What to put in the signature HTML: `<img src="cid:<contentId>">`. Today the image id. */
  contentId: z.string(),
  /** Short-lived presigned link for the editor preview. */
  previewUrl: z.url(),
  previewUrlExpiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type SignatureImageResponse = z.infer<typeof signatureImageResponseSchema>;

/** GET /v1/mailbox/signature/images; oldest first. */
export const listSignatureImagesResponseSchema = z.object({
  images: z.array(signatureImageResponseSchema),
});
export type ListSignatureImagesResponse = z.infer<typeof listSignatureImagesResponseSchema>;

/**
 * POST /v1/mailbox/signature/images: the body is the raw image bytes with its Content-Type;
 * `?fileName=` names it. 201 SignatureImageResponse. 413 image_too_large, 415
 * unsupported_image_type (declared type not allowed, or the bytes are not that type), 409
 * signature_image_limit_reached, 503 signature_images_unavailable (no bucket configured).
 */
export const uploadSignatureImageQuerySchema = z.object({
  fileName: z.string().trim().min(1).max(SIGNATURE_IMAGE_FILE_NAME_MAX_LENGTH).optional(),
});

/**
 * DELETE /v1/mailbox/signature/images/:imageId. 204; 404 not_found; 409 signature_image_in_use
 * while the stored signature still references the image (remove it from the signature first).
 */
