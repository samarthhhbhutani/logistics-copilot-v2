import createHttpError from 'http-errors';
import type { z } from 'zod';

/** parseRequestBody for the query string: a 400 `invalid_query: limit: ...` names every failing parameter. */
export function parseRequestQuery<Schema extends z.ZodType>(
  schema: Schema,
  query: unknown,
): z.output<Schema> {
  const result = schema.safeParse(query);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw createHttpError(400, `invalid_query: ${problems.join('; ')}`);
  }
  return result.data;
}
