import { describe, expect, it } from 'vitest';
import {
  contentIdsToPreviewUrls,
  previewUrlsToContentIds,
  referencedContentIds,
} from './signatureImageReferences.js';

const mailboxId = '00000000-0000-4000-8000-000000000001';
const logoId = '00000000-0000-4000-8000-000000000031';
const badgeId = '00000000-0000-4000-8000-000000000032';
function image(id: string, signature: string) {
  return {
    id,
    fileName: `${id.slice(-2)}.png`,
    contentType: 'image/png' as const,
    sizeBytes: 3,
    contentId: id,
    previewUrl: `https://bucket.example/signatures/${mailboxId}/${id}?X-Amz-Signature=${signature}`,
    previewUrlExpiresAt: '2026-11-20T10:15:00.000Z',
    createdAt: '2026-11-20T10:00:00.000Z',
  };
}
const images = [image(logoId, 'aaa'), image(badgeId, 'bbb')];

describe('contentIdsToPreviewUrls', () => {
  it('swaps known cids for preview URLs and leaves unknown or non-cid sources alone', () => {
    const stored = `<p>Ops Desk</p><img src="cid:${logoId}" alt="Logo" width="120"><img src='cid:${badgeId}'><img src="cid:unknown"><img src="https://x.example/a.png">`;
    expect(contentIdsToPreviewUrls(stored, images)).toBe(
      `<p>Ops Desk</p><img src="${images[0]!.previewUrl}" alt="Logo" width="120"><img src='${images[1]!.previewUrl}'><img src="cid:unknown"><img src="https://x.example/a.png">`,
    );
  });
});

describe('previewUrlsToContentIds', () => {
  it('matches a preview by path even when the presigned query string has changed', () => {
    const refreshed = `https://bucket.example/signatures/${mailboxId}/${logoId}?X-Amz-Signature=zzz&X-Amz-Expires=300`;
    const editor = `<p><img src="${refreshed}" alt="Logo"></p><p><img src="cid:${badgeId}"></p><img src="https://elsewhere.example/signatures/${mailboxId}/${logoId}"><img src="not a url">`;
    expect(previewUrlsToContentIds(editor, images)).toBe(
      `<p><img src="cid:${logoId}" alt="Logo"></p><p><img src="cid:${badgeId}"></p><img src="cid:${logoId}"><img src="not a url">`,
    );
  });
  it('round-trips through both directions', () => {
    const stored = `<p>Hi<br><img src="cid:${logoId}"></p>`;
    expect(previewUrlsToContentIds(contentIdsToPreviewUrls(stored, images), images)).toBe(stored);
  });
});

describe('referencedContentIds', () => {
  it('lists the ids the editor HTML still shows, by preview URL or cid', () => {
    const editor = `<img src="${images[0]!.previewUrl}"><p>text</p><img src="cid:${badgeId}">`;
    expect([...referencedContentIds(editor, images)].sort()).toEqual([logoId, badgeId].sort());
    expect(referencedContentIds('<p>no images</p>', images).size).toBe(0);
  });
});
