import type { ScheduledEvent } from 'aws-lambda';

/**
 * Runs every 12 hours. Shell: logs the tick. The real handler (roadmap 1.8) renews the Gmail
 * `users.watch` subscription of every connected mailbox whose watch expires within 24 hours.
 * The stale-`sending` sweep (4.5) gets its own Lambda, `stuckSendRecoverer`, not this one.
 */
export async function handler(event: ScheduledEvent): Promise<void> {
  console.info(JSON.stringify({ message: 'gmailWatchRenewer shell invoked', time: event.time }));
}
