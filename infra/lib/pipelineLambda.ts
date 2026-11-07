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
}

/**
 * One of the pipeline Lambdas with everything they share: Node 22 on arm64, the handler
 * bundled from apps/lambdas by esbuild, the OpenTelemetry layer exporting straight to Grafana
 * Cloud, one month of logs. Per-function wiring (SQS source, schedule, URL) is done by the stack.
 */
export class PipelineLambda extends NodejsFunction {
  constructor(scope: Construct, id: string, props: PipelineLambdaProps) {
    const { stage, name, timeout, memorySize } = props;
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
      bundling: {
        // CommonJS so the OTel layer's require hook can patch modules; ESM would bypass it.
        format: OutputFormat.CJS,
        sourceMap: true,
        // esbuild exports `handler` as a non-configurable getter, which the layer's aws-lambda
        // instrumentation cannot wrap ("Cannot redefine property: handler"). Re-export it as a
        // plain property.
        footer: 'module.exports = { handler: module.exports.handler };',
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
