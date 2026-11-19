import type { SignatureImageResponse } from '@lc/contract';

/**
 * The stored signature references its images as `cid:<contentId>` (what the mail carries). The
 * editor can only show a URL, so the two directions below swap between the stored form and each
 * image's short-lived preview URL. Only `src` attributes of `<img>` tags are touched.
 */
const IMAGE_SRC = /(<img\b[^>]*?\bsrc=)(["'])([^"']*)\2/gi;

export function contentIdsToPreviewUrls(
  signatureHtml: string,
  images: readonly SignatureImageResponse[],
): string {
  const previewUrlByContentId = new Map(images.map((image) => [image.contentId, image.previewUrl]));
  return signatureHtml.replace(IMAGE_SRC, (match, prefix: string, quote: string, src: string) => {
    if (!src.startsWith('cid:')) return match;
    const previewUrl = previewUrlByContentId.get(src.slice('cid:'.length));
    return previewUrl ? `${prefix}${quote}${previewUrl}${quote}` : match;
  });
}

/**
 * A preview URL is matched by its path (`/signatures/<mailboxId>/<imageId>`), never by the whole
 * string: presigned query strings change on every listing. An `<img>` that is neither a known
 * preview nor already a `cid:` is left as is; the server's sanitiser drops it on save.
 */
export function previewUrlsToContentIds(
  editorHtml: string,
  images: readonly SignatureImageResponse[],
): string {
  const contentIdByPath = new Map(
    images.map((image) => [new URL(image.previewUrl).pathname, image.contentId]),
  );
  return editorHtml.replace(IMAGE_SRC, (match, prefix: string, quote: string, src: string) => {
    if (src.startsWith('cid:')) return match;
    let path: string;
    try {
      path = new URL(src).pathname;
    } catch {
      return match;
    }
    const contentId = contentIdByPath.get(path);
    return contentId ? `${prefix}${quote}cid:${contentId}${quote}` : match;
  });
}

/** The content ids the editor HTML still references; what Delete must refuse for. */
export function referencedContentIds(
  editorHtml: string,
  images: readonly SignatureImageResponse[],
): Set<string> {
  const referenced = new Set<string>();
  for (const [, , , src] of previewUrlsToContentIds(editorHtml, images).matchAll(IMAGE_SRC)) {
    if (src?.startsWith('cid:')) referenced.add(src.slice('cid:'.length));
  }
  return referenced;
}
