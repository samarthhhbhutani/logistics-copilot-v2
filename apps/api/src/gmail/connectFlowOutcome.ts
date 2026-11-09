import type { Response } from 'express';
import type { ConnectFlowErrorCode } from '@lc/contract';

export type ConnectFlowOutcome =
  { connected: true } | { connected: false; error: ConnectFlowErrorCode; expectedEmail?: string };

/**
 * The callback is a top-level browser navigation from Google, so its answer is a redirect to the
 * portal's /mailbox page with the outcome in the query string. Without PORTAL_URL (local dev,
 * curl) the same outcome is returned as JSON so the flow can be exercised without a frontend.
 */
export function sendConnectFlowOutcome(
  response: Response,
  outcome: ConnectFlowOutcome,
  portalUrl: string | undefined,
): void {
  if (!portalUrl) {
    response.status(outcome.connected ? 200 : 400).json(outcome);
    return;
  }
  const target = new URL('/mailbox', portalUrl);
  if (outcome.connected) {
    target.searchParams.set('connected', '1');
  } else {
    target.searchParams.set('error', outcome.error);
    if (outcome.expectedEmail) target.searchParams.set('expectedEmail', outcome.expectedEmail);
  }
  response.redirect(302, target.toString());
}
