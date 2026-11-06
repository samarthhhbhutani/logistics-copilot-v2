import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

/** Instrumentation scope name for every span and metric this package creates. */
export const CORE_INSTRUMENTATION_SCOPE = 'lc.core';

/**
 * Run an async operation inside a span with a business name, so the auto-instrumented HTTP span
 * underneath (POST api.openai.com, POST gmail.googleapis.com/...) gets a parent that says what it
 * was for.
 *
 *   return runInsideSpan('openai.classify', () => client.chat.completions.create(request));
 *
 * Any throw marks the span ERROR, records the exception and rethrows. Nothing is swallowed.
 * With no SDK registered (local runs, unit tests without a provider) the tracer is a no-op and
 * the operation simply runs.
 */
export async function runInsideSpan<Result>(
  operationName: string,
  operation: (span: Span) => Promise<Result>,
  spanAttributes?: Attributes,
): Promise<Result> {
  const tracer = trace.getTracer(CORE_INSTRUMENTATION_SCOPE);
  return tracer.startActiveSpan(operationName, { attributes: spanAttributes }, async (span) => {
    try {
      return await operation(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
