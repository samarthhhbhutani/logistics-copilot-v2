import { GmailApiError } from '@lc/core';
import type { GmailApiErrorCode, GmailSender, OutboundMessage } from '@lc/core';

export interface FakeGmailSender extends GmailSender {
  /** Make the next messages.send fail with this GmailApiError code. */
  failNextSendWith: GmailApiErrorCode | undefined;
  sentMessages: { refreshToken: string; message: OutboundMessage; threadId: string | undefined }[];
}

/** The status Gmail sends with each code; undefined models a transport failure with no response. */
const FAKE_HTTP_STATUS_BY_CODE: Record<GmailApiErrorCode, number | undefined> = {
  invalid_grant: 400,
  bad_request: 400,
  forbidden: 403,
  gmail_api_disabled: 403,
  not_found: 404,
  rate_limited: 429,
  topic_rejected: 400,
  topic_not_authorized: 403,
  request_failed: undefined,
};

/** Stands in for Gmail messages.send: records what was sent, answers with deterministic ids. */
export function createFakeGmailSender(): FakeGmailSender {
  const fake: FakeGmailSender = {
    failNextSendWith: undefined,
    sentMessages: [],
    async sendMessage({ refreshToken, message, threadId }) {
      if (fake.failNextSendWith) {
        const code = fake.failNextSendWith;
        fake.failNextSendWith = undefined;
        throw new GmailApiError(code, FAKE_HTTP_STATUS_BY_CODE[code], `fake ${code}`);
      }
      fake.sentMessages.push({ refreshToken, message, threadId });
      const sequence = fake.sentMessages.length;
      return {
        gmailMessageId: `fake-gmail-message-${sequence}`,
        gmailThreadId: threadId ?? `fake-gmail-thread-${sequence}`,
      };
    },
  };
  return fake;
}
