import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

/** Instrumentation scope for every span and metric this package creates. */
export const INSTRUMENTATION_SCOPE = 'lc.core';

/**
 * Run work inside a span with a business name, so the auto-instrumented HTTP span underneath
 * (POST api.openai.com, POST gmail.googleapis.com/...) gets a parent that says what it was for.
 *
 *   return withSpan(OPENAI_SPAN.classify, () => client.chat.completions.create(request));
 *
 * Any throw marks the span ERROR, records the exception and rethrows. Nothing is swallowed.
 * With no SDK registered (local runs, unit tests without a provider) the tracer is a no-op and
 * the work simply runs.
 */
export async function withSpan<T>(
  name: string,
  work: (span: Span) => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  const tracer = trace.getTracer(INSTRUMENTATION_SCOPE);
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (thrown) {
      span.recordException(thrown instanceof Error ? thrown : String(thrown));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw thrown;
    } finally {
      span.end();
    }
  });
}
