import type { OutboundMessage } from './composeOutboundMime.js';
import type { EmailAddress } from './parsedEmail.js';

/** Config STAGE values; kept local so utils does not depend on config.ts. */
export type OutboundMailStage = 'dev' | 'staging' | 'prod';

export interface OutboundMailSafeModeOptions {
  /** Config STAGE: decides whether `redirectAllMailTo` is required (staging) or forbidden (prod). */
  stage: OutboundMailStage;
  /**
   * Safe mode: every mail goes to this address instead of its real recipients, who are kept in
   * X-Lc-Intended-To / X-Lc-Intended-Cc and a note at the top of the body. Config
   * OUTBOUND_MAIL_REDIRECT_TO. Undefined: send to the real recipients.
   */
  redirectAllMailTo?: string;
}

/**
 * Safe-mode rewrite: the mail keeps everything (subject, threading headers, Message-ID) but is
 * addressed to `redirectTo` only, with the intended recipients kept in headers and in a note.
 * Pure, so the rule is testable without a mailbox. Hand-rolled: this is our policy, not a mail
 * concern any library covers.
 */
export function redirectOutboundMessage(
  message: OutboundMessage,
  redirectTo: string,
): OutboundMessage {
  const intendedTo = formatAddressList(message.to) || '(none)';
  const intendedCc = formatAddressList(message.cc ?? []);
  const noteLines = [`[Redirected by safe mode. Intended To: ${intendedTo}]`];
  if (intendedCc) noteLines.push(`[Intended Cc: ${intendedCc}]`);
  const extraHeaders: Record<string, string> = {
    ...message.extraHeaders,
    'X-Lc-Intended-To': intendedTo,
  };
  if (intendedCc) extraHeaders['X-Lc-Intended-Cc'] = intendedCc;
  return {
    ...message,
    to: [{ name: '', address: redirectTo }],
    cc: undefined,
    text: `${noteLines.join('\n')}\n\n${message.text}`,
    extraHeaders,
  };
}

function formatAddressList(addresses: EmailAddress[]): string {
  return addresses
    .map((address) => (address.name ? `${address.name} <${address.address}>` : address.address))
    .join(', ');
}

/**
 * Safe mode is stage policy, not a feature flag: staging must redirect so a test tenant can
 * never mail a real vendor, prod must not so the redirect cannot leak into real traffic. Checked
 * where the sender is built, so the API fails at startup rather than on the first send.
 */
export function assertOutboundRedirectMatchesStage(options: OutboundMailSafeModeOptions): void {
  if (options.stage === 'staging' && options.redirectAllMailTo === undefined) {
    throw new Error(
      'OUTBOUND_MAIL_REDIRECT_TO is required when STAGE=staging (outbound mail safe mode)',
    );
  }
  if (options.stage === 'prod' && options.redirectAllMailTo !== undefined) {
    throw new Error(
      'OUTBOUND_MAIL_REDIRECT_TO must be unset when STAGE=prod (it would redirect every real mail)',
    );
  }
}
