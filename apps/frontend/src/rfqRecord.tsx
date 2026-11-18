import type { RefObject } from 'react';
import type { RfqWithMailsResponse, VendorResponse } from '@lc/contract';
import { RfqSendStatus } from './rfqSendStatus.js';

/**
 * The panel after a reload, when the API already has an RFQ for the opened mail: what was asked of
 * whom and what came back. The form and the mail texts are not shown because they are not stored
 * (only the ports and incoterm are columns); each vendor's conversation is, one Gmail thread per
 * contact, reachable from its row. No Retry here: the PUT body that a retry repeats is gone; another
 * request for the same mail is the panel's own "Request vendor quotes again" button.
 */
export function RfqRecord({
  result,
  vendors,
  emailId,
  statusHeadingRef,
  polling,
  onClose,
}: {
  result: RfqWithMailsResponse;
  vendors: VendorResponse[];
  emailId: string;
  statusHeadingRef: RefObject<HTMLHeadingElement | null>;
  polling: boolean;
  onClose: () => void;
}) {
  const { rfq } = result;
  return (
    <div className="rfqForm rfqRecord" aria-label="Vendor quotes requested">
      <p className="eyebrow">Vendor quotes</p>
      <p className="muted rfqSourceNote">
        Requested{' '}
        <time dateTime={rfq.createdAt}>
          {new Date(rfq.createdAt).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </time>
        {' · '}
        {rfq.originPort} → {rfq.destinationPort}
        {rfq.incoterm ? ` · ${rfq.incoterm}` : ''}. Each vendor has their own conversation; open it
        from the row.
      </p>
      <RfqSendStatus
        mails={result.mails}
        vendors={vendors}
        headingId={`rfq-send-status-${emailId}`}
        headingRef={statusHeadingRef}
        polling={polling}
        retrying={false}
        onRetry={null}
      />
      <div className="rfqActions">
        <button type="button" className="button textButton" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
