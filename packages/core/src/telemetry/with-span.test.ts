import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INSTRUMENTATION_SCOPE, withSpan } from './with-span.js';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  // What sdk-node / the Lambda layer register for us in production: a tracer provider and the
  // async context manager that makes startActiveSpan() nest across awaits.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(provider);
});
beforeEach(() => exporter.reset());
afterAll(() => {
  trace.disable();
  context.disable();
});

describe('withSpan()', () => {
  it('names the span, returns the value and ends with UNSET status on success', async () => {
    const out = await withSpan('openai.classify', async () => 42, {
      'gen_ai.request.model': 'gpt-6-luna',
    });
    expect(out).toBe(42);
    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('openai.classify');
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
    expect(span!.attributes).toEqual({ 'gen_ai.request.model': 'gpt-6-luna' });
    expect(span!.instrumentationScope.name).toBe(INSTRUMENTATION_SCOPE);
  });

  it('marks ERROR, records the exception and rethrows on throw', async () => {
    await expect(
      withSpan('gmail.send', async () => {
        throw new Error('quota');
      }),
    ).rejects.toThrow('quota');
    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.events[0]!.name).toBe('exception');
    expect(span!.events[0]!.attributes).toMatchObject({ 'exception.message': 'quota' });
  });

  it('nests: a span opened inside work becomes a child of the outer span', async () => {
    await withSpan('agent.run', async () => withSpan('agent.tool', async () => undefined));
    const spans = exporter.getFinishedSpans();
    const inner = spans.find((span) => span.name === 'agent.tool')!;
    const outer = spans.find((span) => span.name === 'agent.run')!;
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
  });

  it('hands the live span to work so it can add attributes mid-flight', async () => {
    await withSpan('agent.tool', async (span) => {
      span.setAttribute('agent.tool', 'search_inbox');
    });
    expect(exporter.getFinishedSpans()[0]!.attributes).toEqual({ 'agent.tool': 'search_inbox' });
  });
});
