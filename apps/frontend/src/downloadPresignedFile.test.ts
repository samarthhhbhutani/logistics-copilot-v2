import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadPresignedFile } from './downloadPresignedFile.js';

const signedUrl = 'https://storage.example/synthetic.png?signature=synthetic';
const signal = () => new AbortController().signal;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('presigned downloads', () => {
  it('omits cookies/referrer and downloads once before returning inert bytes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('abc', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    const file = await downloadPresignedFile(signedUrl, 3, signal());
    expect(await file.text()).toBe('abc');
    expect(file.type).toBe('application/octet-stream');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      signedUrl,
      expect.objectContaining({
        credentials: 'omit',
        mode: 'cors',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retries a reset twice and succeeds on the third call without changing the signed URL', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const result = downloadPresignedFile(signedUrl, 2, signal());
    await vi.advanceTimersByTimeAsync(1500);
    expect(await (await result).text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === signedUrl)).toBe(true);
  });
  it('enforces five seconds to response headers on each of exactly three attempts', async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const result = expect(downloadPresignedFile(signedUrl, 10, signal())).rejects.toMatchObject({
      name: 'RequestTimeoutError',
      phase: 'response',
    });
    await vi.advanceTimersByTimeAsync(16_501);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('allows a body past five seconds when headers arrived but caps the full transfer at twenty', async () => {
    const cancellations = vi.fn();
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(new ReadableStream({ cancel: cancellations }))),
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = expect(downloadPresignedFile(signedUrl, 10, signal())).rejects.toMatchObject({
      phase: 'total',
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancellations).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(56_500);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cancellations).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('accepts a streamed body completing after the response-header deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode('ok'));
                controller.close();
              }, 6_000);
            },
          }),
        ),
      ),
    );
    const result = downloadPresignedFile(signedUrl, 2, signal());
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await (await result).text()).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels an active body and never retries after the reader closes', async () => {
    const cancelled = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled })));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const result = expect(
      downloadPresignedFile(signedUrl, 10, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await result;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([401, 403, 404])('never retries permanent storage HTTP %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(downloadPresignedFile(signedUrl, 100, signal())).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('cancels an oversized stream without retrying or allocating the remaining body', async () => {
    const cancelled = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4));
          },
          cancel: cancelled,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(downloadPresignedFile(signedUrl, 3, signal())).rejects.toThrow(
      'download_too_large',
    );
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('rejects declared oversized bodies and unsafe URLs before allocating them', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('large', { headers: { 'content-length': '100' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(downloadPresignedFile(signedUrl, 3, signal())).rejects.toThrow(
      'download_too_large',
    );
    await expect(downloadPresignedFile('http://storage.example/file', 3, signal())).rejects.toThrow(
      'invalid_download_url',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
