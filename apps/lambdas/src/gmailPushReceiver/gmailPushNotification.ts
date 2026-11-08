/** What Gmail puts in the Pub/Sub message for a watched mailbox. */
export interface GmailPushNotification {
  emailAddress: string;
  /** The mailbox's history id when the change happened; the cursor should end up at or past it. */
  historyId: bigint;
  pubsubMessageId: string;
}

interface PubsubPushBody {
  message?: { data?: string; messageId?: string };
}

/**
 * Pub/Sub wraps the publisher's bytes in { message: { data: base64, messageId }, subscription }.
 * Returns undefined for anything that does not decode to Gmail's { emailAddress, historyId }.
 */
export function parseGmailPushNotification(
  rawBody: string | undefined,
): GmailPushNotification | undefined {
  if (!rawBody) return undefined;
  let body: PubsubPushBody;
  try {
    body = JSON.parse(rawBody) as PubsubPushBody;
  } catch {
    return undefined;
  }
  const data = body.message?.data;
  const pubsubMessageId = body.message?.messageId;
  if (typeof data !== 'string' || typeof pubsubMessageId !== 'string') return undefined;
  let payload: { emailAddress?: unknown; historyId?: unknown };
  try {
    payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as typeof payload;
  } catch {
    return undefined;
  }
  const { emailAddress, historyId } = payload;
  if (typeof emailAddress !== 'string' || emailAddress.length === 0) return undefined;
  if (
    (typeof historyId !== 'number' && typeof historyId !== 'string') ||
    !/^\d+$/.test(String(historyId))
  ) {
    return undefined;
  }
  return { emailAddress, historyId: BigInt(historyId), pubsubMessageId };
}
