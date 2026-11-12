import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RETRY_AFTER_MS,
  PRESIGNED_REQUEST_TIMEOUTS,
  RequestHttpError,
  RequestTimeoutError,
  parseRetryAfterMs,
  readNetworkResponse,
  requestWithRetry,
} from './frontendRequest.js';

const url = 'https://bucket.example/secret-object?X-Amz-Signature=abc';
const readText = (response: Response) => readNetworkResponse(response.text());

function hangUntilAborted(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

function streamingResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (streamController) => void (controller = streamController),
  });
  return { response: new Response(body), controller };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('requestWithRetry HTTP status handling', () => {
  it('makes exactly three attempts with 500ms then 1000ms backoff and hands the final transient response to the consumer', async () => {
    fetchMock.mockImplementation(async () => new Response('busy', { status: 503 }));
    const consume = vi.fn(async (response: Response) => response.status);
    const pending = requestWithRetry(url, {}, consume);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(consume).toHaveBeenCalledOnce();
  });

  it.each([408, 429, 500, 502, 504])('retries transient %i', async (status) => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response('ok'));
    const pending = requestWithRetry(url, {}, readText);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 409])(
    'hands permanent %i to the consumer without retrying',
    async (status) => {
      fetchMock.mockResolvedValue(new Response(null, { status }));
      const pending = requestWithRetry(url, {}, async (response) => {
        throw new RequestHttpError(response.status);
      });
      await expect(pending).rejects.toEqual(new RequestHttpError(status));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('retries only GET and HEAD by default and replays a POST only when marked replay-safe', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    await expect(
      requestWithRetry(url, { method: 'POST' }, async (response) => response.status),
    ).resolves.toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    const replayed = requestWithRetry(
      url,
      { method: 'post' },
      async (response) => response.status,
      undefined,
      {
        replaySafe: true,
      },
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(replayed).resolves.toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockClear();
    const head = requestWithRetry(url, { method: 'HEAD' }, async (response) => response.status);
    await vi.advanceTimersByTimeAsync(1_500);
    await head;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('cancels the discarded body of a retried response', async () => {
    const { response } = streamingResponse();
    const cancel = vi.spyOn(response.body!, 'cancel');
    Object.defineProperty(response, 'status', { value: 503 });
    fetchMock.mockResolvedValueOnce(response).mockResolvedValueOnce(new Response('ok'));
    const pending = requestWithRetry(url, {}, readText);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe('ok');
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('Retry-After', () => {
  it('waits the server-requested delay instead of the backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response('ok'));
    const pending = requestWithRetry(url, {}, readText);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails with the response rather than retrying early when the requested wait is too long', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    );
    await expect(requestWithRetry(url, {}, async (response) => response.status)).resolves.toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses delta seconds and HTTP dates, ignoring garbage', () => {
    const now = Date.parse('2026-11-12T10:00:00.000Z');
    expect(parseRetryAfterMs('3', now)).toBe(3_000);
    expect(parseRetryAfterMs('Thu, 12 Nov 2026 10:00:04 GMT', now)).toBe(4_000);
    expect(parseRetryAfterMs('Thu, 12 Nov 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
    expect(parseRetryAfterMs('-1', now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(MAX_RETRY_AFTER_MS).toBe(5_000);
  });
});

describe('network and consumer failures', () => {
  it('makes exactly three attempts on a network failure, then throws it', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const pending = requestWithRetry(url, {}, readText);
    const assertion = expect(pending).rejects.toThrow(TypeError);
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a network failure while reading the body', async () => {
    const failing = streamingResponse();
    fetchMock.mockResolvedValueOnce(failing.response).mockResolvedValueOnce(new Response('ok'));
    const pending = requestWithRetry(url, {}, readText);
    await vi.advanceTimersByTimeAsync(0);
    failing.controller.error(new TypeError('network error'));
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Error('download_too_large'),
    new SyntaxError('bad json'),
    new TypeError('application bug'),
  ])('does not retry an application error from the consumer (%s)', async (error) => {
    fetchMock.mockResolvedValue(new Response('ok'));
    await expect(
      requestWithRetry(url, {}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not replay an opted-in POST when application logic throws TypeError', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    const error = new TypeError('application bug');
    await expect(
      requestWithRetry(
        url,
        { method: 'POST' },
        async () => {
          throw error;
        },
        undefined,
        { replaySafe: true },
      ),
    ).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('still retries an opted-in POST after a native body-read failure', async () => {
    const failing = streamingResponse();
    fetchMock.mockResolvedValueOnce(failing.response).mockResolvedValueOnce(new Response('ok'));
    const pending = requestWithRetry(url, { method: 'POST' }, readText, undefined, {
      replaySafe: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    failing.controller.error(new TypeError('network error'));
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts the attempt so an unread body is released when the consumer rejects it', async () => {
    const unread = streamingResponse();
    fetchMock.mockResolvedValue(unread.response);
    let consumerSignal: AbortSignal | undefined;
    await expect(
      requestWithRetry(url, {}, async (_response, signal) => {
        consumerSignal = signal;
        throw new Error('download_unavailable');
      }),
    ).rejects.toThrow('download_unavailable');
    expect(consumerSignal?.aborted).toBe(true);
  });

  it('keeps URLs out of error messages', () => {
    expect(new RequestTimeoutError('response').message).not.toContain('bucket');
    expect(new RequestHttpError(503, 1_000)).toMatchObject({ status: 503, retryAfterMs: 1_000 });
    expect(new RequestHttpError(503).message).toBe('Request failed with HTTP 503');
  });
});

describe('per-attempt deadlines', () => {
  it('cancels a fetch that has no response headers after 5s and retries', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal!);
      return hangUntilAborted(input, init);
    });
    const pending = requestWithRetry(url, {}, readText, PRESIGNED_REQUEST_TIMEOUTS);
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'RequestTimeoutError',
      phase: 'response',
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500 + 5_000 + 1_000 + 5_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('allows a body beyond 5s once headers arrived early', async () => {
    const slow = streamingResponse();
    fetchMock.mockResolvedValueOnce(slow.response);
    const pending = requestWithRetry(url, {}, readText, PRESIGNED_REQUEST_TIMEOUTS);
    await vi.advanceTimersByTimeAsync(15_000);
    slow.controller.enqueue(new TextEncoder().encode('image'));
    slow.controller.close();
    await expect(pending).resolves.toBe('image');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts a slow body at the 20s total deadline, then retries', async () => {
    const attemptSignals: AbortSignal[] = [];
    fetchMock.mockImplementation(async () => streamingResponse().response);
    const pending = requestWithRetry(
      url,
      {},
      async (response, signal) => {
        attemptSignals.push(signal);
        return response.text();
      },
      PRESIGNED_REQUEST_TIMEOUTS,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'RequestTimeoutError',
      phase: 'total',
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(attemptSignals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(attemptSignals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500 + 20_000 + 1_000 + 20_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('enforces the deadline even if the consumer ignores its signal', async () => {
    fetchMock.mockImplementation(async () => new Response('ok'));
    const pending = requestWithRetry(url, {}, () => new Promise<never>(() => undefined), {
      responseTimeoutMs: 100,
      totalTimeoutMs: 200,
    });
    const assertion = expect(pending).rejects.toMatchObject({ phase: 'total' });
    await vi.advanceTimersByTimeAsync(200 + 500 + 200 + 1_000 + 200);
    await assertion;
  });

  it('applies no deadline when timeouts are omitted', async () => {
    fetchMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(new Response('late')), 60_000)),
    );
    const pending = requestWithRetry(url, {}, readText);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toBe('late');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('caller cancellation', () => {
  it('never fetches when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(requestWithRetry(url, { signal: controller.signal }, readText)).rejects.toThrow(
      'gone',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts the in-flight fetch and does not retry, even for a TypeError reason', async () => {
    fetchMock.mockImplementation(hangUntilAborted);
    const controller = new AbortController();
    const reason = new TypeError('cancelled');
    const pending = requestWithRetry(
      url,
      { signal: controller.signal },
      readText,
      PRESIGNED_REQUEST_TIMEOUTS,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetchMock.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards cancellation to the body read', async () => {
    const slow = streamingResponse();
    fetchMock.mockResolvedValue(slow.response);
    const controller = new AbortController();
    let consumerSignal: AbortSignal | undefined;
    const pending = requestWithRetry(
      url,
      { signal: controller.signal },
      async (response, signal) => {
        consumerSignal = signal;
        return response.text();
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('unmounted'));
    await expect(pending).rejects.toThrow('unmounted');
    expect(consumerSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops during backoff without another request', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const controller = new AbortController();
    const pending = requestWithRetry(url, { signal: controller.signal }, readText);
    await vi.advanceTimersByTimeAsync(200);
    controller.abort(new Error('navigated'));
    await expect(pending).rejects.toThrow('navigated');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
