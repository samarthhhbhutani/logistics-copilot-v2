import type { SessionResponse } from '@lc/contract';
import { FrontendApiError, frontendApi } from './frontendApi.js';
import { selectInlineAttachments } from './sanitizeEmailHtml.js';

/** Decode only an API-approved stored image. No email-supplied URL reaches this function. */
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
          await verifyImage(url, controller.signal);
          return [contentId, url] as const;
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
