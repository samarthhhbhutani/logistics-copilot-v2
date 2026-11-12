import { App } from 'aws-cdk-lib';
import { LogisticsCopilotStack } from '../lib/logisticsCopilotStack.js';
import {
  AWS_ACCOUNT_ID,
  AWS_REGION,
  resolveFrontendOrigins,
  resolveStage,
} from '../lib/stageConfig.js';

const app = new App();
const stage = resolveStage(app);

new LogisticsCopilotStack(app, `LogisticsCopilot-${stage}`, {
  stage,
  frontendOrigins: resolveFrontendOrigins(app, stage),
  env: { account: AWS_ACCOUNT_ID, region: AWS_REGION },
  description: `Logistics Copilot v2 ${stage}: raw-mail bucket, Gmail message-id queue, Railway IAM user`,
});
