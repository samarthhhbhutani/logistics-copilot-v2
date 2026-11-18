import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SignatureImage } from '@lc/core';

export interface SignatureImagePreviewUrl {
  url: string;
  expiresAt: Date;
}

/** The bytes behind signature_images rows: the raw-mail bucket under signatures/<mailboxId>/<imageId>. */
export interface SignatureImageStore {
  putImage(s3Key: string, content: Uint8Array, contentType: string): Promise<void>;
  readImage(image: SignatureImage): Promise<Uint8Array>;
  deleteImage(s3Key: string): Promise<void>;
  /** A link the editor can show the image from without credentials; `inline`, so it renders rather than downloads. */
  createPreviewUrl(image: SignatureImage): Promise<SignatureImagePreviewUrl>;
}

export function signatureImageS3Key(mailboxId: string, imageId: string): string {
  return `signatures/${mailboxId}/${imageId}`;
}

/** Long enough for an editing session; the editor re-lists to refresh. */
export const SIGNATURE_IMAGE_PREVIEW_URL_TTL_SECONDS = 60 * 60;

export function createS3SignatureImageStore(input: {
  s3Client: S3Client;
  bucketName: string;
  now?: () => Date;
}): SignatureImageStore {
  const { s3Client, bucketName, now = () => new Date() } = input;
  return {
    async putImage(s3Key, content, contentType) {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
          Body: content,
          ContentType: contentType,
        }),
      );
    },
    async readImage(image) {
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: image.s3Key }),
      );
      if (!object.Body) throw new Error(`empty object ${image.s3Key}`);
      return object.Body.transformToByteArray();
    },
    async deleteImage(s3Key) {
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: s3Key }));
    },
    async createPreviewUrl(image) {
      const signedAt = now();
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: bucketName,
          Key: image.s3Key,
          ResponseContentType: image.contentType,
          ResponseContentDisposition: 'inline',
        }),
        { expiresIn: SIGNATURE_IMAGE_PREVIEW_URL_TTL_SECONDS, signingDate: signedAt },
      );
      return {
        url,
        expiresAt: new Date(signedAt.getTime() + SIGNATURE_IMAGE_PREVIEW_URL_TTL_SECONDS * 1000),
      };
    },
  };
}
