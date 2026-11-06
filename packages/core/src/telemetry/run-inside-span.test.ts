import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_INSTRUMENTATION_SCOPE, runInsideSpan } from './run-inside-span.js';

const inMemorySpanExporter = new InMemorySpanExporter();

beforeAll(() => {
  // What sdk-node / the Lambda layer register for us in production: a tracer provider and the
  // async context manager that makes startActiveSpan() nest across awaits.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const tracerProvider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: inMemorySpanExporter })],
  });
  trace.setGlobalTracerProvider(tracerProvider);
});
beforeEach(() => inMemorySpanExporter.reset());
afterAll(() => {
  trace.disable();
  context.disable();
});

describe('runInsideSpan()', () => {
  it('names the span, returns the result and ends with UNSET status on success', async () => {
    const result = await runInsideSpan('openai.classify', async () => 42, {
      'gen_ai.request.model': 'gpt-6-luna',
    });
    expect(result).toBe(42);
    const [finishedSpan] = inMemorySpanExporter.getFinishedSpans();
    expect(finishedSpan!.name).toBe('openai.classify');
    expect(finishedSpan!.status.code).toBe(SpanStatusCode.UNSET);
    expect(finishedSpan!.attributes).toEqual({ 'gen_ai.request.model': 'gpt-6-luna' });
    expect(finishedSpan!.instrumentationScope.name).toBe(CORE_INSTRUMENTATION_SCOPE);
  });

  it('marks ERROR, records the exception and rethrows on throw', async () => {
    await expect(
      runInsideSpan('gmail.send', async () => {
        throw new Error('quota');
      }),
    ).rejects.toThrow('quota');
    const [finishedSpan] = inMemorySpanExporter.getFinishedSpans();
    expect(finishedSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(finishedSpan!.events[0]!.name).toBe('exception');
    expect(finishedSpan!.events[0]!.attributes).toMatchObject({ 'exception.message': 'quota' });
  });

  it('nests: an operation traced inside another becomes its child span', async () => {
    await runInsideSpan('agent.run', async () =>
      runInsideSpan('agent.tool', async () => undefined),
    );
    const finishedSpans = inMemorySpanExporter.getFinishedSpans();
    const childSpan = finishedSpans.find((span) => span.name === 'agent.tool')!;
    const parentSpan = finishedSpans.find((span) => span.name === 'agent.run')!;
    expect(childSpan.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
    expect(childSpan.spanContext().traceId).toBe(parentSpan.spanContext().traceId);
  });

  it('hands the live span to the operation so it can add attributes mid-flight', async () => {
    await runInsideSpan('agent.tool', async (span) => {
      span.setAttribute('agent.tool', 'search_inbox');
    });
    expect(inMemorySpanExporter.getFinishedSpans()[0]!.attributes).toEqual({
      'agent.tool': 'search_inbox',
    });
  });
});
