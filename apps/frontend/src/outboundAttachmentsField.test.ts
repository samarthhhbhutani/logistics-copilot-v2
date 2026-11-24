// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboundAttachmentResponse } from '@lc/contract';
import { frontendApi, FrontendApiError } from './frontendApi.js';
import { formatFileSize, OutboundAttachmentsField } from './outboundAttachmentsField.js';

const session = {
  tenantId: '00000000-0000-4000-8000-000000000002',
  mailboxId: '00000000-0000-4000-8000-000000000001',
};
function attachmentOf(file: File, id: string): OutboundAttachmentResponse {
  return {
    id,
    fileName: file.name,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    createdAt: '2026-11-24T09:00:00.000Z',
  };
}
function fileOf(name: string, sizeBytes: number, type = 'application/pdf') {
  return new File([new Uint8Array(sizeBytes)], name, { type });
}
/** Answers each upload in turn with a stored file under the next id, or with the given error. */
function answerUploads(...answers: (string | Error)[]) {
  const upload = vi.spyOn(frontendApi, 'uploadOutboundAttachment');
  for (const answer of answers) {
    if (answer instanceof Error) upload.mockRejectedValueOnce(answer);
    else
      upload.mockImplementationOnce((_session, file) =>
        Promise.resolve(attachmentOf(file, answer)),
      );
  }
  return upload;
}

let container: HTMLDivElement;
let root: Root | undefined;
let queryClient: QueryClient;
let attachments: OutboundAttachmentResponse[];
const onAttachmentsChange = vi.fn((next: OutboundAttachmentResponse[]) => {
  attachments = next;
});

async function render(disabled = false) {
  root ??= createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(OutboundAttachmentsField, {
          session,
          attachments,
          onAttachmentsChange,
          disabled,
        }),
      ),
    );
  });
}
/** React Query notifies through a setTimeout(0): wait one macrotask for the mutation to settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function pick(...files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  // The parent re-renders with the list the field reported.
  await render();
}
function chips() {
  return [...container.querySelectorAll('[aria-label="Attached files"] li')].map(
    (chip) => chip.textContent,
  );
}
function button(name: string) {
  return [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.includes(name) || candidate.ariaLabel === name,
  );
}
async function click(name: string) {
  const target = button(name);
  if (!target) throw new Error(`no button "${name}"`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
  await render();
}
function alertText() {
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  attachments = [];
  onAttachmentsChange.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('formatFileSize', () => {
  it('shows bytes, KB or MB with one decimal', () => {
    expect(formatFileSize(812)).toBe('812 bytes');
    expect(formatFileSize(41_472)).toBe('40.5 KB');
    expect(formatFileSize(10 * 1024 * 1024 - 200_000)).toBe('9.8 MB');
  });
});

describe('OutboundAttachmentsField', () => {
  it('uploads picked files one after another, lists them, and removes one on request', async () => {
    const upload = answerUploads('a1', 'a2');
    const remove = vi.spyOn(frontendApi, 'deleteOutboundAttachment').mockResolvedValue();
    await render();
    expect(chips()).toEqual([]);

    await pick(fileOf('rates.pdf', 41_472), fileOf('terms.docx', 812));
    expect(upload.mock.calls.map(([, file]) => file.name)).toEqual(['rates.pdf', 'terms.docx']);
    expect(chips()).toEqual(['rates.pdf40.5 KB', 'terms.docx812 bytes']);
    expect(onAttachmentsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'a1' }),
      expect.objectContaining({ id: 'a2' }),
    ]);

    await click('Remove rates.pdf');
    expect(remove).toHaveBeenCalledWith(session, 'a1');
    expect(chips()).toEqual(['terms.docx812 bytes']);
    expect(alertText()).toBeNull();
  });

  it('stops at the first refused file, keeps the ones before it and names the reason', async () => {
    const upload = answerUploads('a1', new FrontendApiError(415, 'blocked_file_type'), 'a3');
    await render();
    await pick(fileOf('rates.pdf', 100), fileOf('setup.exe', 100), fileOf('terms.pdf', 100));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(chips()).toEqual(['rates.pdf100 bytes']);
    expect(alertText()).toBe(
      'setup.exe: Gmail does not deliver files of this type. Zip it with a different name or share it another way.',
    );

    // The next pick starts clean.
    answerUploads('a3');
    await pick(fileOf('terms.pdf', 100));
    expect(alertText()).toBeNull();
    expect(chips()).toEqual(['rates.pdf100 bytes', 'terms.pdf100 bytes']);
  });

  it('refuses an eleventh file and a pick that would push the total past 18 MB before uploading', async () => {
    const upload = answerUploads();
    attachments = Array.from({ length: 10 }, (_, index) =>
      attachmentOf(fileOf(`file-${index}.pdf`, 1024), `a${index}`),
    );
    await render();
    expect(button('Attach files')!.disabled).toBe(true);
    await pick(fileOf('one-more.pdf', 100));
    expect(upload).not.toHaveBeenCalled();
    expect(alertText()).toBe('one-more.pdf: A mail can carry at most 10 files.');

    attachments = [attachmentOf(fileOf('big.pdf', 17 * 1024 * 1024), 'big')];
    await render();
    await pick(fileOf('too-much.pdf', 2 * 1024 * 1024));
    expect(upload).not.toHaveBeenCalled();
    expect(alertText()).toBe(
      'too-much.pdf: Attachments total more than 18 MB. Remove a file to send.',
    );
    expect(chips()).toEqual(['big.pdf17 MB']);
  });

  it('drops a chip whose upload is already gone, and keeps one the server would not delete', async () => {
    attachments = [
      attachmentOf(fileOf('a.pdf', 10), 'a1'),
      attachmentOf(fileOf('b.pdf', 10), 'a2'),
    ];
    const remove = vi
      .spyOn(frontendApi, 'deleteOutboundAttachment')
      .mockRejectedValueOnce(new FrontendApiError(404, 'not_found'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await render();
    await click('Remove a.pdf');
    expect(chips()).toEqual(['b.pdf10 bytes']);
    expect(alertText()).toBeNull();

    await click('Remove b.pdf');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(chips()).toEqual(['b.pdf10 bytes']);
    expect(alertText()).toBe(
      'b.pdf: We could not reach your workspace. Check your connection and try again.',
    );
  });

  it('freezes the list while the reply is with Gmail', async () => {
    attachments = [attachmentOf(fileOf('a.pdf', 10), 'a1')];
    await render(true);
    expect(button('Attach files')!.disabled).toBe(true);
    expect(button('Remove a.pdf')!.disabled).toBe(true);
  });
});
