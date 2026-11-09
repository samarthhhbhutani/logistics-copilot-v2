import { describe, expect, it } from 'vitest';
import { GmailApiError } from './gmailApiError.js';
import { toWatchError } from './gmailWatch.js';

describe('toWatchError', () => {
  it('names the onboarding mistake behind a users.watch 400 or 403', () => {
    expect(toWatchError(new GmailApiError('bad_request', 400, 'Invalid topicName')).code).toBe(
      'topic_rejected',
    );
    expect(toWatchError(new GmailApiError('forbidden', 403, 'User not authorized')).code).toBe(
      'topic_not_authorized',
    );
  });

  it('keeps the detail once and leaves every other code alone', () => {
    const rejected = toWatchError(new GmailApiError('bad_request', 400, 'Invalid topicName'));
    expect(rejected.message).toBe('topic_rejected: Invalid topicName');
    const disabled = new GmailApiError('gmail_api_disabled', 403);
    expect(toWatchError(disabled)).toBe(disabled);
    const dead = new GmailApiError('invalid_grant', 400);
    expect(toWatchError(dead)).toBe(dead);
  });
});
