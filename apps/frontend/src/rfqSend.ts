import type {
  RfqMailText,
  RfqMailWithRepliesResponse,
  SentMailResponse,
  VendorCategory,
} from '@lc/contract';
import { vendorCategoryTitles } from './rfqRecipients.js';

/** The operator's edited text for one category, as the panel keeps it. */
export interface RfqMailDraftValues {
  subject: string;
  bodyText: string;
}
export type RfqMailDrafts = Partial<Record<VendorCategory, RfqMailDraftValues>>;

/**
 * The texts the send needs: one per category among the ticked vendors, subject and message both
 * filled in. The first gap is the one message the panel shows, so the operator fixes one thing at a time.
 */
export function mailTextsForSend(
  categories: VendorCategory[],
  drafts: RfqMailDrafts | null,
): { ok: true; mails: RfqMailText[] } | { ok: false; message: string } {
  const mails: RfqMailText[] = [];
  for (const category of categories) {
    const draft = drafts?.[category];
    const title = vendorCategoryTitles[category];
    if (!draft)
      return {
        ok: false,
        message: `No mail drafted for ${title} yet. Write the vendor mails first.`,
      };
    const subject = draft.subject.trim();
    const bodyText = draft.bodyText.trim();
    if (!subject) return { ok: false, message: `The ${title} mail needs a subject.` };
    if (!bodyText) return { ok: false, message: `The ${title} mail needs a message.` };
    mails.push({ category, subject, bodyText });
  }
  return { ok: true, mails };
}

export type RfqMailTone = 'sent' | 'sending' | 'waiting' | 'failed';

export interface RfqMailStatusView {
  tone: RfqMailTone;
  label: string;
  /** Why, when the mail is not simply sent; null otherwise. */
  detail: string | null;
}

/** Written by the sent-mail sweeper after an hour with no SENT copy: Gmail very likely never took it. */
export const SEND_UNCONFIRMED_ERROR_CODE = 'send_unconfirmed';
/** Written by the sweeper when Gmail could not even be asked: the mail may or may not have gone out. */
export const SEND_UNVERIFIABLE_ERROR_CODE = 'send_unverifiable';

const FAILURE_DETAILS: Record<string, string> = {
  invalid_grant: 'The Gmail connection needs to be reconnected before this can be sent.',
  rate_limited: 'Gmail is rate limiting sends from this mailbox. Retry in a minute.',
  forbidden: 'Gmail refused to send from this mailbox.',
  gmail_api_disabled: 'The Gmail API is disabled for this workspace.',
  bad_request: 'Gmail rejected the message. Check the address and the text.',
  [SEND_UNCONFIRMED_ERROR_CODE]:
    'Gmail did not confirm this mail went out. Retrying sends it again.',
  [SEND_UNVERIFIABLE_ERROR_CODE]:
    'Delivery could not be verified. Check your Sent folder before retrying, or the vendor may get it twice.',
};

export function describeSentMailStatus(mail: SentMailResponse): RfqMailStatusView {
  switch (mail.status) {
    case 'sent':
      return { tone: 'sent', label: 'Sent', detail: null };
    case 'sending':
      return {
        tone: 'sending',
        label: 'Sending',
        detail: 'Handed to Gmail; waiting for it to confirm.',
      };
    case 'pending':
      return {
        tone: 'waiting',
        label: 'Not sent yet',
        detail: 'The batch stopped before this one. Retry sends it.',
      };
    case 'failed':
      return {
        tone: 'failed',
        label: 'Failed',
        detail:
          (mail.errorCode && FAILURE_DETAILS[mail.errorCode]) ??
          `Gmail refused the send${mail.errorCode ? ` (${mail.errorCode})` : ''}.`,
      };
  }
}

export function anyMailSending(mails: SentMailResponse[]): boolean {
  return mails.some((mail) => mail.status === 'sending');
}

/** Mails the same PUT would send again: failed, and pending ones the batch never reached. */
export function countRetryableMails(mails: SentMailResponse[]): number {
  return mails.filter((mail) => mail.status === 'failed' || mail.status === 'pending').length;
}

/** True when some failed mail may already have reached the vendor, so a retry deserves a warning. */
export function anyUnverifiableMail(mails: SentMailResponse[]): boolean {
  return mails.some(
    (mail) => mail.status === 'failed' && mail.errorCode === SEND_UNVERIFIABLE_ERROR_CODE,
  );
}

/** Contacts the RFQ reached or may still reach: every mail that is not `failed`. The API's contactCount rule. */
export function countReachableContacts(mails: SentMailResponse[]): number {
  return mails.filter((mail) => mail.status !== 'failed').length;
}

/** Contacts who wrote back at least once; a vendor who wrote twice is one. */
export function countRepliedContacts(mails: RfqMailWithRepliesResponse[]): number {
  return mails.filter((mail) => mail.status !== 'failed' && mail.replies.count > 0).length;
}

/** The collapsed panel's one line once an RFQ exists for the mail: how many vendors have come back. */
export function rfqProgressLabel(mails: RfqMailWithRepliesResponse[]): string {
  const reachable = countReachableContacts(mails);
  if (reachable === 0) return 'Vendor quotes: no mail reached a vendor';
  const replied = countRepliedContacts(mails);
  return replied === 0
    ? `Vendor quotes: ${reachable === 1 ? '1 vendor asked' : `${reachable} vendors asked`}, none replied yet`
    : `Vendor quotes: ${replied} of ${reachable} replied`;
}
