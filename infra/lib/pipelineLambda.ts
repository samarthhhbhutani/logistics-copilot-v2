import { RemovalPolicy } from 'aws-cdk-lib';
import type { Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import {
  GRAFANA_OTLP_ENDPOINT,
  OTEL_LAMBDA_LAYER_ARN,
  otelExporterHeadersParameterName,
} from './stageConfig.js';
import type { Stage } from './stageConfig.js';

export type PipelineLambdaName = 'gmailPushReceiver' | 'emailProcessor' | 'gmailWatchRenewer';

export interface PipelineLambdaProps {
  stage: Stage;
  name: PipelineLambdaName;
  timeout: Duration;
  memorySize: number;
  /** Per-function additions to the shared environment (queue URLs, secret names; never secret values). */
  environment?: Record<string, string>;
  reservedConcurrentExecutions?: number;
}

/**
 * One of the pipeline Lambdas with everything they share: Node 22 on arm64, the handler
 * bundled from apps/lambdas by esbuild, the OpenTelemetry layer exporting straight to Grafana
 * Cloud, one month of logs. Per-function wiring (SQS source, schedule, URL) is done by the stack.
 */
export class PipelineLambda extends NodejsFunction {
  constructor(scope: Construct, id: string, props: PipelineLambdaProps) {
    const {
      stage,
      name,
      timeout,
      memorySize,
      environment = {},
      reservedConcurrentExecutions,
    } = props;
    const kebabName = toKebabCase(name);
    const otelExporterHeaders = ssm.StringParameter.valueForStringParameter(
      scope,
      otelExporterHeadersParameterName(stage),
    );
    super(scope, id, {
      functionName: `logistics-copilot-${kebabName}-${stage}`,
      entry: fileURLToPath(new URL(`../../apps/lambdas/src/${name}/handler.ts`, import.meta.url)),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout,
      memorySize,
      reservedConcurrentExecutions,
      bundling: {
        // CommonJS so the OTel layer's require hook can patch modules; ESM would bypass it.
        format: OutputFormat.CJS,
        sourceMap: true,
        // esbuild exports `handler` as a non-configurable getter, which the layer's aws-lambda
        // instrumentation cannot wrap ("Cannot redefine property: handler"). Re-export it as a
        // plain property.
        footer: 'module.exports = { handler: module.exports.handler };',
        // Prisma's generated client computes __dirname from import.meta.url, which is empty in
        // CommonJS output; give it the bundle's own path instead.
        banner: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;",
        define: { 'import.meta.url': 'import_meta_url' },
        // Native addon behind the API's password hashing; @lc/core only imports it lazily and no
        // Lambda hashes passwords, so it stays out of the bundle.
        externalModules: ['@aws-sdk/*', 'argon2'],
        // The layer registers the global tracer with @opentelemetry/api 1.9.1, and a newer api copy
        // (ours is 1.10) rejects an older global: runInsideSpan would get a no-op tracer and our
        // spans would vanish while the layer's auto-instrumentation still shows. Bundle a 1.9 api
        // instead (apps/lambdas devDependency `@opentelemetry/api-layer`). Drop when the layer
        // ships api 1.10.
        esbuildArgs: { '--alias:@opentelemetry/api': '@opentelemetry/api-layer' },
      },
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(scope, `${id}OtelLayer`, OTEL_LAMBDA_LAYER_ARN),
      ],
      environment: {
        STAGE: stage,
        NODE_OPTIONS: '--enable-source-maps',
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-handler',
        OTEL_SERVICE_NAME: `logistics-copilot-${kebabName}`,
        OTEL_RESOURCE_ATTRIBUTES: `deployment.environment.name=${stage}`,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_EXPORTER_OTLP_ENDPOINT: GRAFANA_OTLP_ENDPOINT,
        // Resolved by CloudFormation at deploy from SSM; the template holds only the parameter name.
        OTEL_EXPORTER_OTLP_HEADERS: otelExporterHeaders,
        OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'aws-lambda,aws-sdk,http,undici,pg',
        OTEL_LOGS_EXPORTER: 'none',
        ...environment,
      },
      logGroup: new logs.LogGroup(scope, `${id}LogGroup`, {
        logGroupName: `/aws/lambda/logistics-copilot-${kebabName}-${stage}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
  }
}

/** AWS resource names follow the kebab-case convention of the queues; code and folders stay camelCase. */
function toKebabCase(camelCase: string): string {
  return camelCase.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`);
}
