import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AttachmentSummary } from '@lc/core';

export interface AttachmentDownloadUrl {
  url: string;
  expiresAt: Date;
}

export interface AttachmentDownloadUrlSigner {
  /** A link the browser can follow without credentials, valid briefly, downloading under the original file name. */
  createDownloadUrl(attachment: AttachmentSummary): Promise<AttachmentDownloadUrl>;
}

/** Long enough to click; short enough that a leaked link is near useless. */
export const ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * RFC 6266 Content-Disposition for a download. `attachment` stops the browser rendering the file
 * in place (an HTML or SVG attachment must never execute on the storage origin). The ASCII
 * fallback keeps old clients working; filename* carries the real name for everyone else.
 */
/** Both forms of the name travel in the presigned URL's query string; a hostile name must not blow URL limits. */
const MAX_DOWNLOAD_FILE_NAME_LENGTH = 200;

export function attachmentContentDisposition(fileName: string): string {
  const singleLine =
    fileName
      .replaceAll(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, MAX_DOWNLOAD_FILE_NAME_LENGTH) || 'attachment';
  const asciiFallback = singleLine.replaceAll(/[^\x20-\x7e]/g, '_').replaceAll(/["\\]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(singleLine)}`;
}

function encodeRfc5987(value: string): string {
  // encodeURIComponent leaves !'()* alone; RFC 5987 attr-char does not allow them.
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function createS3AttachmentDownloadUrlSigner(input: {
  s3Client: S3Client;
  bucketName: string;
  now?: () => Date;
}): AttachmentDownloadUrlSigner {
  const { s3Client, bucketName, now = () => new Date() } = input;
  return {
    async createDownloadUrl(attachment) {
      const signedAt = now();
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: bucketName,
          Key: attachment.s3Key,
          ResponseContentDisposition: attachmentContentDisposition(attachment.fileName),
          ResponseContentType: attachment.contentType,
        }),
        { expiresIn: ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS, signingDate: signedAt },
      );
      return {
        url,
        expiresAt: new Date(signedAt.getTime() + ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS * 1000),
      };
    },
  };
}
