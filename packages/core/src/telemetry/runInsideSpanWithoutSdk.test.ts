import { describe, expect, it } from 'vitest';
import { runInsideSpan } from './runInsideSpan.js';

// Runs in its own file so no tracer provider is registered in this worker.
describe('runInsideSpan() without a registered SDK', () => {
  it('is a no-op wrapper: runs the operation and rethrows errors', async () => {
    await expect(runInsideSpan('x', async () => 'ok')).resolves.toBe('ok');
    await expect(
      runInsideSpan('x', async () => {
        throw new Error('still thrown');
      }),
    ).rejects.toThrow('still thrown');
  });
});
