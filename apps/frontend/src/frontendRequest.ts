export const PRESIGNED_REQUEST_TIMEOUTS = {
  responseTimeoutMs: 5_000,
  totalTimeoutMs: 20_000,
} as const;
/** A longer server-requested wait fails now rather than retrying earlier than the server asked. */
export const MAX_RETRY_AFTER_MS = 5_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_DELAYS_MS = [500, 1_000];
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD']);

export interface RequestTimeouts {
  responseTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface RequestRetryOptions {
  /** Opt a reviewed non-GET request into replay, e.g. a POST with no side effect beyond a cookie. */
  replaySafe?: boolean;
}

export class RequestTimeoutError extends Error {
  constructor(readonly phase: 'response' | 'total') {
    super(`Request timed out (${phase})`);
    this.name = 'RequestTimeoutError';
  }
}

/** Only fetch and owned response-body reads may classify a failure as network-related. */
class RequestNetworkError extends TypeError {
  constructor() {
    super('Network request failed');
    this.name = 'RequestNetworkError';
  }
}

/** Keep this boundary around a native fetch/body-read promise, never application logic. */
export async function readNetworkResponse<T>(pending: Promise<T>): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof TypeError) throw new RequestNetworkError();
    throw error;
  }
}

export class RequestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Request failed with HTTP ${status}`);
    this.name = 'RequestHttpError';
  }
}

export function parseRetryAfterMs(
  headerValue: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (headerValue === null || headerValue.trim() === '') return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const retryAtMs = Date.parse(trimmed);
  return Number.isNaN(retryAtMs) ? undefined : Math.max(0, retryAtMs - nowMs);
}

export async function requestWithRetry<T>(
  url: string,
  options: RequestInit,
  consumeResponse: (response: Response, signal: AbortSignal) => Promise<T>,
  timeouts?: RequestTimeouts,
  retryOptions: RequestRetryOptions = {},
): Promise<T> {
  const callerSignal = options.signal ?? undefined;
  const method = (options.method ?? 'GET').toUpperCase();
  const attemptLimit =
    retryOptions.replaySafe || REPLAY_SAFE_METHODS.has(method) ? MAX_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    callerSignal?.throwIfAborted();
    const isLastAttempt = attempt >= attemptLimit;
    const backoffMs = BACKOFF_DELAYS_MS[attempt - 1] ?? 0;
    let outcome: AttemptOutcome<T>;
    try {
      outcome = await runAttempt(url, options, consumeResponse, timeouts, isLastAttempt);
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (isLastAttempt || !isRetryableFailure(error)) throw error;
      await waitForRetry(backoffMs, callerSignal);
      continue;
    }
    if (outcome.kind === 'consumed') return outcome.value;
    await waitForRetry(outcome.retryAfterMs ?? backoffMs, callerSignal);
  }
}

type AttemptOutcome<T> = { kind: 'consumed'; value: T } | { kind: 'retry'; retryAfterMs?: number };

async function runAttempt<T>(
  url: string,
  options: RequestInit,
  consumeResponse: (response: Response, signal: AbortSignal) => Promise<T>,
  timeouts: RequestTimeouts | undefined,
  isLastAttempt: boolean,
): Promise<AttemptOutcome<T>> {
  const attemptController = new AbortController();
  const callerSignal = options.signal ?? undefined;
  const abortFromCaller = () => attemptController.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const abortWithTimeout = (phase: RequestTimeoutError['phase']) =>
    attemptController.abort(new RequestTimeoutError(phase));
  let responseTimer = timeouts
    ? setTimeout(() => abortWithTimeout('response'), timeouts.responseTimeoutMs)
    : undefined;
  const totalTimer = timeouts
    ? setTimeout(() => abortWithTimeout('total'), timeouts.totalTimeoutMs)
    : undefined;
  try {
    if (callerSignal?.aborted) abortFromCaller();
    const response = await rejectOnAbort(
      readNetworkResponse(fetch(url, { ...options, signal: attemptController.signal })),
      attemptController.signal,
    );
    clearTimeout(responseTimer);
    responseTimer = undefined;
    if (!isLastAttempt && TRANSIENT_STATUSES.has(response.status)) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
      if (retryAfterMs === undefined || retryAfterMs <= MAX_RETRY_AFTER_MS) {
        response.body?.cancel().catch(() => undefined);
        return { kind: 'retry', retryAfterMs };
      }
    }
    const value = await rejectOnAbort(
      consumeResponse(response, attemptController.signal),
      attemptController.signal,
    );
    return { kind: 'consumed', value };
  } catch (error) {
    // Prefer our typed reason: some runtimes reject an aborted fetch with a generic AbortError.
    if (attemptController.signal.aborted) throw attemptController.signal.reason;
    // Releases a body the consumer left unread, e.g. after rejecting a non-OK or oversized file.
    attemptController.abort();
    throw error;
  } finally {
    clearTimeout(responseTimer);
    clearTimeout(totalTimer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Enforces the deadline even when a consumer ignores the signal it was given. */
function rejectOnAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const rejectWithReason = () => reject(signal.reason);
    const settle = () => signal.removeEventListener('abort', rejectWithReason);
    pending.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
    if (signal.aborted) rejectWithReason();
    else signal.addEventListener('abort', rejectWithReason, { once: true });
  });
}

/** Application TypeErrors are never replayed; native reads explicitly classify network failures. */
function isRetryableFailure(error: unknown): boolean {
  return error instanceof RequestTimeoutError || error instanceof RequestNetworkError;
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abortWait = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abortWait);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abortWait, { once: true });
  });
}
