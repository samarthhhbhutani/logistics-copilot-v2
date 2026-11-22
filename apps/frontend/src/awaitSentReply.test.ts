import { describe, expect, it } from 'vitest';
import type { SentMailResponse } from '@lc/contract';
import {
  awaitSentReply,
  awaitedSentReplyStored,
  SENT_REPLY_POLL_MS,
  SENT_REPLY_POLL_TIMEOUT_MS,
  sentReplyPollInterval,
} from './awaitSentReply.js';

const sentMail = { rfcMessageId: '<reply-1@desk.example>' } as SentMailResponse;
const awaited = awaitSentReply(sentMail, 1_000);
const stored = [
  { rfcMessageId: '<older@desk.example>' },
  { rfcMessageId: '<reply-1@desk.example>' },
];
const notYet = [{ rfcMessageId: '<older@desk.example>' }, { rfcMessageId: null }];

describe('awaitSentReply', () => {
  it('waits for the sent mail by its Message-ID for a bounded time', () => {
    expect(awaited).toEqual({
      rfcMessageId: '<reply-1@desk.example>',
      untilMs: 1_000 + SENT_REPLY_POLL_TIMEOUT_MS,
    });
    expect(awaitedSentReplyStored(awaited, stored)).toBe(true);
    expect(awaitedSentReplyStored(awaited, notYet)).toBe(false);
  });

  it('polls only while the mail is missing and the wait has not run out', () => {
    expect(sentReplyPollInterval(null, notYet, 2_000)).toBe(false);
    expect(sentReplyPollInterval(awaited, undefined, 2_000)).toBe(SENT_REPLY_POLL_MS);
    expect(sentReplyPollInterval(awaited, notYet, 2_000)).toBe(SENT_REPLY_POLL_MS);
    expect(sentReplyPollInterval(awaited, stored, 2_000)).toBe(false);
    expect(sentReplyPollInterval(awaited, notYet, awaited.untilMs)).toBe(false);
  });
});
