import type { SessionResponse } from '@lc/contract';
import { FrontendApiError, frontendApi } from './frontendApi.js';
import { selectInlineAttachments } from './sanitizeEmailHtml.js';
import { downloadPresignedFile } from './downloadPresignedFile.js';

/** A bounded, downloaded raster image. No network request is made during decoding. */
function verifyImage(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const image = new Image();
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
      image.onload = null;
      image.onerror = null;
    };
    const fail = (error: unknown) => {
      cleanup();
      image.removeAttribute('src');
      reject(error);
    };
    const aborted = () => fail(signal.reason);
    const timeout = setTimeout(() => fail(new Error('inline_image_timeout')), 15_000);
    image.referrerPolicy = 'no-referrer';
    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => fail(new Error('inline_image_unavailable'));
    signal.addEventListener('abort', aborted, { once: true });
    image.src = url;
  });
}

/** Data URLs work inside an opaque frame without granting it access to our origin's blob store. */
function rasterDataUrl(blob: Blob, contentType: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const reader = new FileReader();
    const cleanup = () => {
      signal.removeEventListener('abort', aborted);
      reader.onload = null;
      reader.onerror = null;
    };
    const aborted = () => {
      cleanup();
      reader.abort();
      reject(signal.reason);
    };
    reader.onload = () => {
      cleanup();
      if (typeof reader.result !== 'string') reject(new Error('inline_image_unavailable'));
      else resolve(reader.result);
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error('inline_image_unavailable'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    reader.readAsDataURL(new Blob([blob], { type: contentType }));
  });
}

export async function loadInlineImages(
  session: SessionResponse,
  emailId: string,
  contentIds: string[],
  signal: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const { attachments } = await frontendApi.attachments(session, emailId, controller.signal);
    const matched = selectInlineAttachments(attachments, contentIds);
    // One failed image keeps the message readable. Any failed scoped API read cancels the batch,
    // so an expired/changed session cannot leave a partial set of signed URLs on screen.
    const images = await Promise.all(
      matched.map(async ({ contentId, attachment }) => {
        const { url } = await frontendApi.attachmentDownload(
          session,
          emailId,
          attachment.id,
          controller.signal,
        );
        try {
          const blob = await downloadPresignedFile(url, attachment.sizeBytes, controller.signal);
          const dataUrl = await rasterDataUrl(
            blob,
            attachment.contentType.toLowerCase(),
            controller.signal,
          );
          await verifyImage(dataUrl, controller.signal);
          return [contentId, dataUrl] as const;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          return undefined;
        }
      }),
    );
    const currentSession = await frontendApi.session(controller.signal);
    if (
      currentSession?.tenantId !== session.tenantId ||
      currentSession?.mailboxId !== session.mailboxId
    )
      throw new FrontendApiError(401, 'session_changed');
    signal.throwIfAborted();
    return {
      urls: new Map(images.filter((image) => image !== undefined)),
      failedImageCount: images.filter((image) => image === undefined).length,
    };
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
