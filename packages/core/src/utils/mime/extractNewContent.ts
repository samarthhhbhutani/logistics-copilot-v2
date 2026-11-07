import EmailReplyParser from 'email-reply-parser';
import { collapseWhitespace } from './htmlToPlainText.js';

export interface ExtractNewContentOptions {
  /**
   * Whether the message being quoted is already stored for this mailbox (In-Reply-To or a
   * References id matches). Only then is quoted history safe to drop; for the first message of a
   * thread with us, a reply-all that pulls us in, or a forward, the quoted text is new to us and
   * must reach the classifier and extractor. Defaults to false: when unsure, keep text.
   */
  quotedMessageKnown?: boolean;
}

/**
 * The text the sender typed in this message, without their signature and, when the quoted
 * message is known, without the quoted history. Thin wrapper over Crisp's email-reply-parser
 * (the GitHub reply-parser lineage: "On ... wrote:" in many languages, Outlook header runs,
 * ">" blocks, "-- " and common sign-offs) so callers never depend on the library's shape.
 */
export function extractNewContent(
  bodyText: string,
  { quotedMessageKnown = false }: ExtractNewContentOptions = {},
): string {
  const parsedReply = new EmailReplyParser().read(collapseWhitespace(bodyText));
  const keptFragments = parsedReply
    .getFragments()
    .filter((fragment) => !fragment.isSignature())
    .filter((fragment) => !(quotedMessageKnown && (fragment.isQuoted() || fragment.isHidden())));
  return collapseWhitespace(keptFragments.map((fragment) => fragment.getContent()).join('\n'));
}
