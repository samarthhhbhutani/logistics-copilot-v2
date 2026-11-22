import type { EmailDetailResponse, SentMailResponse } from '@lc/contract';

/** How often the conversation is re-read while a reply we just sent is still missing from it. */
export const SENT_REPLY_POLL_MS = 3_000;
/** How long that goes on: Gmail usually files the sent mail within seconds; after this, "Refresh conversation" remains. */
export const SENT_REPLY_POLL_TIMEOUT_MS = 30_000;

/**
 * A reply the operator just sent that the stored conversation does not show yet. The conversation
 * holds only ingested mail, and our sent copy arrives through Gmail's push notification a few
 * seconds after the send, so the page polls for it instead of asking for a reload.
 */
export interface AwaitedSentReply {
  /** Message-ID we gave the mail; the ingested copy carries the same one. */
  rfcMessageId: string;
  untilMs: number;
}

export function awaitSentReply(sentMail: SentMailResponse, nowMs: number): AwaitedSentReply {
  return { rfcMessageId: sentMail.rfcMessageId, untilMs: nowMs + SENT_REPLY_POLL_TIMEOUT_MS };
}

export function awaitedSentReplyStored(
  awaited: AwaitedSentReply,
  emails: readonly Pick<EmailDetailResponse, 'rfcMessageId'>[],
): boolean {
  return emails.some((email) => email.rfcMessageId === awaited.rfcMessageId);
}

/** The react-query `refetchInterval` for the conversation: poll while a sent reply is awaited and the wait has not run out. */
export function sentReplyPollInterval(
  awaited: AwaitedSentReply | null,
  emails: readonly Pick<EmailDetailResponse, 'rfcMessageId'>[] | undefined,
  nowMs: number,
): number | false {
  if (!awaited || nowMs >= awaited.untilMs) return false;
  if (emails && awaitedSentReplyStored(awaited, emails)) return false;
  return SENT_REPLY_POLL_MS;
}
