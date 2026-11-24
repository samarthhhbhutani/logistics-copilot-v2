import { z } from 'zod';
import { hashPassword } from '../auth/passwordHash.js';
import type { OperatorRepository } from './operatorRepository.js';

/** Same rules as a mailbox login (packages/contract), restated here because core does not depend on contract. */
export const operatorInputSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(256),
});

export type OperatorInput = z.infer<typeof operatorInputSchema>;

/**
 * Creates an operator or resets an existing one's password: the only way an operator account comes
 * to exist, run by a human against the database (createOperatorScript), never over HTTP, so there is
 * no bootstrap problem and no second credential to protect.
 */
export async function bootstrapOperator(
  input: OperatorInput,
  operatorRepository: OperatorRepository,
): Promise<{ operatorId: string; email: string }> {
  const { email, password } = operatorInputSchema.parse(input);
  const operator = await operatorRepository.upsertOperator({
    email,
    passwordHash: await hashPassword(password),
  });
  return { operatorId: operator.operatorId, email: operator.email };
}
