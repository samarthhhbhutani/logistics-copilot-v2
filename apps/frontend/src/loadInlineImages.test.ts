// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontendApiError, frontendApi } from './frontendApi.js';
import { loadInlineImages } from './loadInlineImages.js';

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
    image.onload?.();
    expect(await promise).toEqual({
      urls: new Map([['logo', 'https://storage.example/logo.png']]),
      failedImageCount: 0,
    });
    expect(frontendApi.session).toHaveBeenCalledOnce();
    expect(image.onload).toBeNull();
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
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await promise).toEqual({ urls: new Map(), failedImageCount: 1 });
    expect(TestImage.instances[0]?.source).toBe('');
    expect(TestImage.instances[0]?.onload).toBeNull();
  });
});
