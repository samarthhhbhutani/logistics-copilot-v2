import { register as registerModuleHook } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions/incubating';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

/**
 * OpenTelemetry SDK for the API process. Loaded with `node --import ./instrumentation.js`
 * BEFORE index.js so the http/express/pg instrumentations patch those modules before anything
 * imports them. This is the one place that registers the process-wide tracer and meter providers
 * (README, Composition rules); application code only ever uses @opentelemetry/api.
 *
 * Reads process.env directly because it runs before the composition root exists. The OTLP
 * exporters take endpoint, headers and protocol from the standard OTEL_EXPORTER_OTLP_* variables.
 * With OTEL_EXPORTER_OTLP_ENDPOINT unset (local default) the SDK is not started: nothing is
 * exported, runInsideSpan() is a no-op, and the API behaves exactly as without telemetry.
 */
const SERVICE_NAME = 'logistics-copilot-api';
const METRIC_EXPORT_INTERVAL_MS = 60_000;

const otelSdk = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? startOtelSdk() : undefined;

/**
 * The API is ESM. OpenTelemetry patches third-party modules (express, pg) through an ESM loader
 * hook; without registering it only Node core (http) is instrumented and no http.route appears.
 */
function registerEsmInstrumentationHook(): void {
  registerModuleHook('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
}

function startOtelSdk(): NodeSDK {
  registerEsmInstrumentationHook();
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.STAGE ?? 'dev',
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
    ],
  });
  sdk.start();
  console.log(`telemetry: exporting to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
  return sdk;
}

/** Flush buffered spans and metrics. index.ts awaits this during SIGTERM drain, before exit. */
export async function shutdownTelemetry(): Promise<void> {
  await otelSdk?.shutdown();
}
