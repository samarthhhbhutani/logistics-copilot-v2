import createHttpError from 'http-errors';
import type { z } from 'zod';

/**
 * Validate a JSON request body against a zod schema. Invalid input becomes a 400 whose message
 * names every failing field (`invalid_body: email: Invalid email; password: Too small`), handled
 * by the app's error handler. Routers call this as their first line and work with typed data.
 */
export function parseRequestBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw createHttpError(400, `invalid_body: ${problems.join('; ')}`);
  }
  return result.data;
}
