/** One JSON line per event, the shape the OTel collector and CloudWatch Insights both read. */
export function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  console[level](JSON.stringify({ message, ...fields }));
}
