import request from 'supertest';
import type { Express } from 'express';
import type { SignatureImageResponse } from '@lc/contract';

/** The smallest byte strings file-type recognises as each allowed image type (signature prefixes plus padding). */
export const tinyPng = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.alloc(16, 0),
]);
export const tinyGif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16, 0)]);
export const tinyJpeg = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(16, 0)]);

/** Uploads one image for the signed-in mailbox and returns the 201 body; fails the test on any other status. */
export async function uploadSignatureImage(
  app: Express,
  cookie: string,
  content: Buffer,
  contentType: string,
  fileName?: string,
): Promise<SignatureImageResponse> {
  const response = await request(app)
    .post('/v1/mailbox/signature/images')
    .query(fileName ? { fileName } : {})
    .set('Cookie', cookie)
    .set('Content-Type', contentType)
    .send(content);
  if (response.status !== 201) {
    throw new Error(`upload failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}
