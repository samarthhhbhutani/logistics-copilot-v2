import { loadConfig } from '../config.js';
import { createPrismaOperatorRepository } from './operatorRepository.js';
import { initializePrismaClient } from '../db/prismaClient.js';
import { bootstrapOperator, operatorInputSchema } from './bootstrapOperator.js';

/**
 * `npm run operator:create`: creates an operator or resets its password. Reads OPERATOR_EMAIL and
 * OPERATOR_PASSWORD from the environment (never argv, so they stay out of shell history) and
 * DATABASE_URL via Config. The root .env fills in whatever the shell did not set (dev), and a
 * DATABASE_URL set in the shell wins over it, so one invocation targets staging or production too.
 */
const parsedInput = operatorInputSchema.safeParse({
  email: process.env.OPERATOR_EMAIL,
  password: process.env.OPERATOR_PASSWORD,
});
if (!parsedInput.success) {
  console.error(
    'Set OPERATOR_EMAIL (an email address) and OPERATOR_PASSWORD (6 to 256 characters) in the environment.',
  );
  process.exit(2);
}
const prismaClient = initializePrismaClient(loadConfig(process.env), { maxConnections: 1 });
try {
  const operator = await bootstrapOperator(
    parsedInput.data,
    createPrismaOperatorRepository(prismaClient),
  );
  console.log(`operator ${operator.email} ready (${operator.operatorId})`);
} finally {
  await prismaClient.$disconnect();
}
