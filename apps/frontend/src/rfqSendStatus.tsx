import type { RefObject } from 'react';
import { Check, Clock, RefreshCw, TriangleAlert } from 'lucide-react';
import type { SentMailResponse, VendorResponse } from '@lc/contract';
import {
  anyMailSending,
  anyUnverifiableMail,
  countRetryableMails,
  describeRfqMailStatus,
} from './rfqSend.js';
import type { RfqMailTone } from './rfqSend.js';

const TONE_ICONS: Record<RfqMailTone, typeof Check> = {
  sent: Check,
  sending: RefreshCw,
  waiting: Clock,
  failed: TriangleAlert,
};

/** Where the batch stands, in one line; a mail still with Gmail is "sending", never "not sent". */
export function sendStatusHeading(total: number, sent: number, sending: number): string {
  if (total === 1) {
    if (sent === 1) return 'Mail sent';
    return sending === 1 ? 'Mail sending' : 'Mail not sent';
  }
  if (sent === total) return `All ${total} mails sent`;
  const sentPart = `${sent} of ${total} mails sent`;
  return sending > 0 ? `${sentPart}, ${sending} still sending` : sentPart;
}

/**
 * One row per contact after the send, with where each mail stands. Rows still `sending` are
 * re-read every 10 seconds by the panel until Gmail (or the sweeper) settles them; "Retry failed"
 * repeats the same PUT, which the API answers by sending only what is failed or never reached.
 */
export function RfqSendStatus({
  mails,
  vendors,
  headingId,
  headingRef,
  polling,
  retrying,
  onRetry,
}: {
  mails: SentMailResponse[];
  vendors: VendorResponse[];
  headingId: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  polling: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const vendorNameById = new Map(vendors.map((vendor) => [vendor.id, vendor.vendorName]));
  const sentCount = mails.filter((mail) => mail.status === 'sent').length;
  const retryable = countRetryableMails(mails);
  const sendingCount = mails.filter((mail) => mail.status === 'sending').length;
  return (
    <section className="rfqSendStatus" aria-labelledby={headingId}>
      <h3 id={headingId} ref={headingRef} tabIndex={-1}>
        {sendStatusHeading(mails.length, sentCount, sendingCount)}
      </h3>
      <ul className="rfqMailStatusList">
        {mails.map((mail) => {
          const view = describeRfqMailStatus(mail);
          const Icon = TONE_ICONS[view.tone];
          const recipient = mail.toRecipients[0];
          return (
            <li key={mail.id} className={`rfqMailStatus ${view.tone}`}>
              <Icon
                size={16}
                aria-hidden="true"
                className={view.tone === 'sending' ? 'spinning' : undefined}
              />
              <span className="rfqMailRecipient">
                <strong>{recipient?.name || recipient?.address || 'Contact'}</strong>
                <span>
                  {[vendorNameById.get(mail.vendorId ?? ''), recipient?.address]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="rfqMailOutcome">
                <strong>{view.label}</strong>
                {view.detail && <span>{view.detail}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {polling && anyMailSending(mails) && (
        <p className="muted rfqSendNote" role="status">
          Waiting for Gmail to confirm {sendingCount === 1 ? 'one mail' : `${sendingCount} mails`};
          checking every 10 seconds.
        </p>
      )}
      {retryable > 0 && (
        <div className="rfqActions">
          <button type="button" className="button secondary" disabled={retrying} onClick={onRetry}>
            {retrying
              ? 'Retrying…'
              : retryable === 1
                ? 'Retry the failed mail'
                : `Retry ${retryable} mails`}
          </button>
          {anyUnverifiableMail(mails) && (
            <span role="status">
              Retrying also resends the mail whose delivery could not be verified.
            </span>
          )}
        </div>
      )}
    </section>
  );
}
