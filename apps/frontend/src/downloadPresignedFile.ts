import {
  PRESIGNED_REQUEST_TIMEOUTS,
  RequestHttpError,
  readNetworkResponse,
  requestWithRetry,
} from './frontendRequest.js';

/** Only API-approved signed URLs enter here, never arbitrary email links. */
export async function downloadPresignedFile(
  url: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Blob> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password)
    throw new Error('invalid_download_url');
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new Error('invalid_download_size');
  return requestWithRetry(
    url,
    {
      signal,
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
    },
    async (response, attemptSignal) => {
      if (!response.ok) throw new RequestHttpError(response.status);
      const declaredSize = response.headers.get('content-length');
      if (declaredSize !== null && Number(declaredSize) > maximumBytes)
        throw new Error('download_too_large');
      const reader = response.body?.getReader();
      if (!reader) return new Blob([]);
      const cancelReader = () => {
        void reader.cancel().catch(() => {});
      };
      attemptSignal.addEventListener('abort', cancelReader, { once: true });
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let receivedBytes = 0;
      try {
        while (true) {
          attemptSignal.throwIfAborted();
          const { done, value } = await readNetworkResponse(reader.read());
          if (done) break;
          receivedBytes += value.byteLength;
          if (receivedBytes > maximumBytes) throw new Error('download_too_large');
          chunks.push(new Uint8Array(value));
        }
        attemptSignal.throwIfAborted();
        // Downloads are saved, never executed as the server-supplied content type.
        return new Blob(chunks, { type: 'application/octet-stream' });
      } finally {
        attemptSignal.removeEventListener('abort', cancelReader);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
    PRESIGNED_REQUEST_TIMEOUTS,
  );
}
