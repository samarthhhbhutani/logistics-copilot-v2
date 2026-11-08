import { GmailApiError } from '@lc/core';
import type { GmailApiErrorCode, GmailWatch } from '@lc/core';

export interface FakeGmailWatch extends GmailWatch {
  /** Make the next users.watch fail the way Gmail does for the given onboarding mistake. */
  failNextWatchWith: GmailApiErrorCode | undefined;
  startedWatches: { refreshToken: string; topicName: string }[];
  stoppedWatches: { refreshToken: string }[];
}

export const fakeWatchHistoryId = 4242n;
export const fakeWatchExpiresAt = new Date('2026-11-15T12:00:00.000Z');

/** Stands in for Gmail's watch endpoints: records calls, returns a fixed cursor and expiry. */
export function createFakeGmailWatch(): FakeGmailWatch {
  const fake: FakeGmailWatch = {
    failNextWatchWith: undefined,
    startedWatches: [],
    stoppedWatches: [],
    async startWatch({ refreshToken, topicName }) {
      if (fake.failNextWatchWith) {
        const code = fake.failNextWatchWith;
        fake.failNextWatchWith = undefined;
        throw new GmailApiError(
          code,
          code === 'topic_not_authorized' || code === 'gmail_api_disabled' ? 403 : 400,
        );
      }
      fake.startedWatches.push({ refreshToken, topicName });
      return { historyId: fakeWatchHistoryId, expiresAt: fakeWatchExpiresAt };
    },
    async stopWatch({ refreshToken }) {
      fake.stoppedWatches.push({ refreshToken });
    },
  };
  return fake;
}
