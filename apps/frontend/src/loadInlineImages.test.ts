// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontendApiError, frontendApi } from './frontendApi.js';
import { loadInlineImages } from './loadInlineImages.js';
import * as downloads from './downloadPresignedFile.js';

const session = { tenantId: 'tenant', mailboxId: 'mailbox' };
const attachment = {
  id: 'image',
  fileName: 'logo.png',
  contentType: 'image/png',
  sizeBytes: 100,
  isInline: true,
  contentId: 'logo',
};
class TestImage {
  static instances: TestImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  referrerPolicy = '';
  source = '';
  constructor() {
    TestImage.instances.push(this);
  }
  set src(value: string) {
    this.source = value;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.source = '';
  }
}
async function startImages(signal = new AbortController().signal) {
  const promise = loadInlineImages(session, 'email', ['logo'], signal);
  await vi.waitFor(() => expect(TestImage.instances).toHaveLength(1));
  return { promise, image: TestImage.instances[0]! };
}
beforeEach(() => {
  TestImage.instances = [];
  vi.stubGlobal('Image', TestImage);
  vi.spyOn(downloads, 'downloadPresignedFile').mockResolvedValue(new Blob(['png']));
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:image/png;base64,cG5n';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(blob: Blob) {
        this.result = `data:${blob.type};base64,cG5n`;
        queueMicrotask(() => this.onload?.());
      }
      abort() {}
    },
  );
  vi.spyOn(frontendApi, 'attachments').mockResolvedValue({
    emailId: 'email',
    attachments: [attachment],
  });
  vi.spyOn(frontendApi, 'attachmentDownload').mockResolvedValue({
    url: 'https://storage.example/logo.png',
    expiresAt: '2026-11-12T12:00:00Z',
  });
  vi.spyOn(frontendApi, 'session').mockResolvedValue(session);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('loadInlineImages', () => {
  it('returns decoded stored images with no referrer after a final identity check', async () => {
    const { promise, image } = await startImages();
    expect(image.referrerPolicy).toBe('no-referrer');
    expect(image.source).toBe('data:image/png;base64,cG5n');
    expect(downloads.downloadPresignedFile).toHaveBeenCalledWith(
      'https://storage.example/logo.png',
      attachment.sizeBytes,
      expect.any(AbortSignal),
    );
    image.onload?.();
    expect(await promise).toEqual({
      urls: new Map([['logo', 'data:image/png;base64,cG5n']]),
      failedImageCount: 0,
    });
    expect(frontendApi.session).toHaveBeenCalledOnce();
    expect(image.onload).toBeNull();
  });
  it('normalizes upper-case attachment MIME before raster decoding', async () => {
    vi.mocked(frontendApi.attachments).mockResolvedValue({
      emailId: 'email',
      attachments: [{ ...attachment, contentType: 'IMAGE/PNG' }],
    });
    const { promise, image } = await startImages();
    expect(image.source).toBe('data:image/png;base64,cG5n');
    image.onload?.();
    expect((await promise).failedImageCount).toBe(0);
  });
  it('leaves broken/expired storage images unresolved so they can be retried', async () => {
    const { promise, image } = await startImages();
    image.onerror?.();
    expect(await promise).toEqual({ urls: new Map(), failedImageCount: 1 });
    expect(image.source).toBe('');
  });
  it('cleans up a decoding image when the reader closes', async () => {
    const controller = new AbortController();
    const { promise, image } = await startImages(controller.signal);
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(image.source).toBe('');
    expect(image.onload).toBeNull();
  });
  it('rejects a session change during image decoding', async () => {
    const { promise, image } = await startImages();
    vi.mocked(frontendApi.session).mockResolvedValue({ ...session, mailboxId: 'different' });
    image.onload?.();
    await expect(promise).rejects.toMatchObject({ code: 'session_changed' });
  });
  it('leaves an exhausted storage transfer unresolved without attempting a second network image load', async () => {
    vi.mocked(downloads.downloadPresignedFile).mockRejectedValue(new Error('download_unavailable'));
    await expect(
      loadInlineImages(session, 'email', ['logo'], new AbortController().signal),
    ).resolves.toEqual({ urls: new Map(), failedImageCount: 1 });
    expect(TestImage.instances).toHaveLength(0);
    expect(frontendApi.session).toHaveBeenCalledOnce();
  });
  it('rejects cancellation during the storage transfer without publishing image bytes', async () => {
    const controller = new AbortController();
    vi.mocked(downloads.downloadPresignedFile).mockImplementation(
      (_url, _size, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const pending = loadInlineImages(session, 'email', ['logo'], controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(downloads.downloadPresignedFile).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(TestImage.instances).toHaveLength(0);
    expect(frontendApi.session).not.toHaveBeenCalled();
  });
  it('propagates signing failures without loading an image', async () => {
    vi.mocked(frontendApi.attachmentDownload).mockRejectedValue(
      new FrontendApiError(401, 'not_authenticated'),
    );
    await expect(
      loadInlineImages(session, 'email', ['logo'], new AbortController().signal),
    ).rejects.toMatchObject({ status: 401 });
    expect(TestImage.instances).toHaveLength(0);
  });
  it('does not sign unknown or unsupported Content-IDs', async () => {
    expect(
      await loadInlineImages(session, 'email', ['missing'], new AbortController().signal),
    ).toEqual({ urls: new Map(), failedImageCount: 0 });
    expect(frontendApi.attachmentDownload).not.toHaveBeenCalled();
  });
  it('cancels sibling images if one scoped signing request fails', async () => {
    vi.mocked(frontendApi.attachments).mockResolvedValue({
      emailId: 'email',
      attachments: [attachment, { ...attachment, id: 'other', contentId: 'other' }],
    });
    let rejectSigning: (error: unknown) => void = () => {};
    vi.mocked(frontendApi.attachmentDownload).mockImplementation(
      async (_session, _emailId, attachmentId) => {
        if (attachmentId === 'other')
          return new Promise((_resolve, reject) => {
            rejectSigning = reject;
          });
        return { url: 'https://storage.example/logo.png', expiresAt: '2026-11-12T12:00:00Z' };
      },
    );
    const promise = loadInlineImages(
      session,
      'email',
      ['logo', 'other'],
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(TestImage.instances).toHaveLength(1));
    const rejected = expect(promise).rejects.toMatchObject({ status: 401 });
    rejectSigning(new FrontendApiError(401, 'not_authenticated'));
    await rejected;
    expect(TestImage.instances[0]?.source).toBe('');
  });
  it('times out an unavailable image and removes its handlers', async () => {
    vi.useFakeTimers();
    const promise = loadInlineImages(session, 'email', ['logo'], new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await promise).toEqual({ urls: new Map(), failedImageCount: 1 });
    expect(TestImage.instances[0]?.source).toBe('');
    expect(TestImage.instances[0]?.onload).toBeNull();
  });
});
