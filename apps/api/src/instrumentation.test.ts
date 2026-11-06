import { describe, expect, it } from 'vitest';

describe('instrumentation', () => {
  it('without OTEL_EXPORTER_OTLP_ENDPOINT the SDK is not started and shutdown is a no-op', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const { shutdownTelemetry } = await import('./instrumentation.js');
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
