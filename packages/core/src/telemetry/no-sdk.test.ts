import { describe, expect, it } from 'vitest';
import { withSpan } from './with-span.js';

// Runs in its own file so no provider is registered in this worker.
describe('withSpan() without a registered SDK', () => {
  it('is a no-op wrapper: runs the work and rethrows errors', async () => {
    await expect(withSpan('x', async () => 'ok')).resolves.toBe('ok');
    await expect(
      withSpan('x', async () => {
        throw new Error('still thrown');
      }),
    ).rejects.toThrow('still thrown');
  });
});
