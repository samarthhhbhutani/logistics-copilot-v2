/**
 * Where a page of the email list ended: the sort key (received_at desc, id desc) of its last row.
 * Keyset paging stays correct while new mail lands at the top, which offsets would not.
 */
export interface EmailListPosition {
  receivedAt: Date;
  id: string;
}

/** Opaque to clients: base64url JSON. Changing the sort key changes the format, so it is not a public shape. */
export function encodeEmailListCursor(position: EmailListPosition): string {
  return Buffer.from(
    JSON.stringify({ receivedAt: position.receivedAt.toISOString(), id: position.id }),
  ).toString('base64url');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Email rows did not exist before the project; anything outside this is a forged cursor, not a real position. */
const EARLIEST_CURSOR_DATE = Date.UTC(2020, 0, 1);
const LATEST_CURSOR_DATE = Date.UTC(2100, 0, 1);

/**
 * Undefined for anything that is not a cursor this code produced. The id must be a UUID and the
 * date within a sane range so a forged cursor is a 400 at the router, never a Postgres error.
 */
export function decodeEmailListCursor(cursor: string): EmailListPosition | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { receivedAt, id } = parsed as Record<string, unknown>;
  if (typeof receivedAt !== 'string' || typeof id !== 'string' || !UUID_PATTERN.test(id))
    return undefined;
  const receivedAtMs = new Date(receivedAt).getTime();
  if (
    Number.isNaN(receivedAtMs) ||
    receivedAtMs < EARLIEST_CURSOR_DATE ||
    receivedAtMs > LATEST_CURSOR_DATE
  )
    return undefined;
  return { receivedAt: new Date(receivedAtMs), id };
}
