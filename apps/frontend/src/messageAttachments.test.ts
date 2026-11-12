// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import { frontendApi } from './frontendApi.js';
import * as downloads from './downloadPresignedFile.js';
import { MessageAttachments } from './messageAttachments.js';

const session = {
  tenantId: '00000000-0000-4000-8000-000000000002',
  mailboxId: '00000000-0000-4000-8000-000000000001',
};
const emailId = '00000000-0000-4000-8000-000000000011';
const attachment = {
  id: 'file-id',
  fileName: 'quote.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  isInline: false,
  contentId: null,
};
const signedUrl = 'https://bucket.example/quote.pdf?X-Amz-Signature=abc';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => (resolve = resolvePromise));
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root | undefined;
let queryClient: QueryClient;
let onSignedOut: Mock<() => void>;
let createObjectURL: Mock<(file: Blob) => string>;
let revokeObjectURL: Mock<(url: string) => void>;
let anchorClick: MockInstance<() => void>;
let clickedAnchors: HTMLAnchorElement[];

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function renderAttachments() {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(MessageAttachments, { session, emailId, onSignedOut }),
      ),
    );
  });
  await flush();
  await flush();
}

function downloadButton() {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Download ${attachment.fileName}"]`,
  );
  if (!button) throw new Error('download button missing');
  return button;
}

async function clickDownload() {
  await act(async () => {
    downloadButton().click();
  });
  await flush();
}

async function unmount() {
  await act(async () => root?.unmount());
  root = undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onSignedOut = vi.fn<() => void>();
  let objectUrlCount = 0;
  createObjectURL = vi.fn((_file: Blob) => `blob:download-${++objectUrlCount}`);
  revokeObjectURL = vi.fn<(url: string) => void>();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  clickedAnchors = [];
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clickedAnchors.push(this);
  });
  vi.spyOn(frontendApi, 'attachments').mockResolvedValue({
    emailId,
    attachments: [attachment],
  });
  vi.spyOn(frontendApi, 'attachmentDownload').mockResolvedValue({
    url: signedUrl,
    expiresAt: '2026-11-12T12:05:00.000Z',
  });
  vi.spyOn(frontendApi, 'session').mockResolvedValue(session);
  vi.spyOn(downloads, 'downloadPresignedFile').mockResolvedValue(new Blob(['pdf']));
});

afterEach(async () => {
  await unmount();
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MessageAttachments downloads', () => {
  it('aborts an in-flight transfer on unmount and never saves it', async () => {
    let transferSignal: AbortSignal | undefined;
    vi.mocked(downloads.downloadPresignedFile).mockImplementation(
      (_url, _maximumBytes, signal) =>
        new Promise<Blob>((_resolve, reject) => {
          transferSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    await renderAttachments();
    await clickDownload();
    expect(downloads.downloadPresignedFile).toHaveBeenCalledWith(
      signedUrl,
      attachment.sizeBytes,
      expect.any(AbortSignal),
    );
    expect(transferSignal?.aborted).toBe(false);

    await unmount();
    await flush();
    expect(transferSignal?.aborted).toBe(true);
    expect(frontendApi.session).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it('saves the blob only after the final session check, without caching it', async () => {
    const file = new Blob(['pdf bytes']);
    vi.mocked(downloads.downloadPresignedFile).mockResolvedValue(file);
    const finalSession = deferred<typeof session>();
    vi.mocked(frontendApi.session).mockReturnValue(finalSession.promise);
    // gcTime 0 evicts the mutation, so record every state it held in the cache.
    const cachedMutationStates: Array<{ status: string; data: unknown }> = [];
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.mutation) cachedMutationStates.push({ ...event.mutation.state });
    });
    onTestFinished(unsubscribe);
    await renderAttachments();
    await clickDownload();

    expect(frontendApi.session).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
    expect(downloadButton().textContent).toContain('Preparing');

    finalSession.resolve(session);
    await flush();
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(file);
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(clickedAnchors[0]).toMatchObject({
      href: 'blob:download-1',
      download: attachment.fileName,
      referrerPolicy: 'no-referrer',
    });
    expect(downloadButton().textContent).toContain('Download');

    expect(cachedMutationStates.some((state) => state.status === 'success')).toBe(true);
    for (const state of cachedMutationStates) {
      expect(state.data).toBeUndefined();
      expect(Object.values(state).some((value) => value instanceof Blob)).toBe(false);
    }
  });

  it('refuses to save and signs out when the cookie changed during the transfer', async () => {
    vi.mocked(frontendApi.session).mockResolvedValue({
      ...session,
      mailboxId: '00000000-0000-4000-8000-000000000009',
    });
    await renderAttachments();
    await clickDownload();
    await flush();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
    expect(onSignedOut).toHaveBeenCalled();
  });

  it('signs out without saving when the session expired during the transfer', async () => {
    vi.mocked(frontendApi.session).mockResolvedValue(null);
    await renderAttachments();
    await clickDownload();
    await flush();
    expect(anchorClick).not.toHaveBeenCalled();
    expect(onSignedOut).toHaveBeenCalled();
  });

  it('revokes the object URL after 60 seconds while the view stays open', async () => {
    await renderAttachments();
    await clickDownload();
    await flush();
    expect(anchorClick).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download-1');

    await unmount();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('revokes the previous object URL on a new download and the current one on unmount', async () => {
    await renderAttachments();
    await clickDownload();
    await flush();
    await clickDownload();
    await flush();
    expect(anchorClick).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download-1');

    await unmount();
    expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:download-2');
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
