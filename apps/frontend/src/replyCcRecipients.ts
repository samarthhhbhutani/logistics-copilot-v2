import { MAX_REPLY_CC_RECIPIENTS, sendReplyRequestSchema } from '@lc/contract';
import type { SendReplyBody } from '@lc/contract';

export type ReplyCcRecipient = NonNullable<SendReplyBody['cc']>[number];

export type ParsedReplyCc =
  | { recipients: ReplyCcRecipient[] }
  /** Shown under the Cc field; nothing is sent. */
  | { problem: string };

/** `Priya Nair <priya@example.com>` or a bare address; anything else is kept as typed so the message can quote it. */
function readRecipient(entry: string): ReplyCcRecipient {
  const named = /^(.*)<([^<>]+)>$/.exec(entry);
  if (!named) return { name: '', address: entry };
  return { name: named[1]!.trim().replace(/^"(.*)"$/, '$1'), address: named[2]!.trim() };
}

/**
 * Reads the Cc field: addresses separated by commas, semicolons or line breaks, each one optionally
 * `Name <address>`. Repeats of an address are sent once. Checked against the same rules the API
 * applies (`sendReplyRequestSchema.cc`), so a problem is caught here rather than as a 400.
 */
export function parseReplyCc(input: string): ParsedReplyCc {
  const entries = input
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const recipients: ReplyCcRecipient[] = [];
  for (const entry of entries) {
    const recipient = readRecipient(entry);
    if (
      !recipients.some((seen) => seen.address.toLowerCase() === recipient.address.toLowerCase())
    ) {
      recipients.push(recipient);
    }
  }
  if (recipients.length > MAX_REPLY_CC_RECIPIENTS) {
    return { problem: `Cc can take at most ${MAX_REPLY_CC_RECIPIENTS} addresses.` };
  }
  const checked = sendReplyRequestSchema.shape.cc.safeParse(recipients);
  if (!checked.success) {
    const index = checked.error.issues[0]?.path[0];
    const culprit = typeof index === 'number' ? recipients[index] : undefined;
    return {
      problem: culprit
        ? `"${culprit.address}" is not an email address.`
        : 'Cc holds something that is not an email address.',
    };
  }
  return { recipients };
}
