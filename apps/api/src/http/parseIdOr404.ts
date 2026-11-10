import createHttpError from 'http-errors';
import { z } from 'zod';

const uuidSchema = z.uuid();

/** A malformed id can match nothing, so it gets the same answer as an unknown one. */
export function parseIdOr404(value: unknown): string {
  const result = uuidSchema.safeParse(value);
  if (!result.success) throw createHttpError(404, 'not_found');
  return result.data;
}
