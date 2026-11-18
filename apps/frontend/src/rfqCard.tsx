import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown, RefreshCw } from 'lucide-react';
import type {
  RfqCustomerMailGroupResponse,
  RfqListItemResponse,
  SessionResponse,
  VendorResponse,
} from '@lc/contract';
import { errorMessage, frontendApi, isUnauthenticated } from './frontendApi.js';
import { formatRoute, rfqProgressPill } from './rfqList.js';
import { RfqSendStatus } from './rfqSendStatus.js';

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * One customer mail and every request for quotes sent from it, newest first (a mail processed twice
 * has two). The card carries only what the list returned; the vendor rows load when a request is
 * expanded, and load again on every expand, so the card never shows a reply older than the page.
 */
export function RfqCustomerMailCard({
  group,
  vendors,
  session,
  onSignedOut,
}: {
  group: RfqCustomerMailGroupResponse;
  vendors: VendorResponse[];
  session: SessionResponse;
  onSignedOut: () => void;
}) {
  const { sourceEmail } = group;
  const sender = sourceEmail.sender.name || sourceEmail.sender.email || 'Unknown sender';
  return (
    <article
      className="rfqCard"
      aria-label={`Vendor quotes for ${sourceEmail.subject || '(No subject)'}`}
    >
      <header className="rfqCardHeader">
        <span className="senderAvatar" aria-hidden="true">
          {sender.slice(0, 1).toUpperCase()}
        </span>
        <div className="rfqCardCustomer">
          <strong>{sender}</strong>
          <span className="rfqCardSubject">{sourceEmail.subject || '(No subject)'}</span>
          <span className="muted">
            Received{' '}
            <time dateTime={sourceEmail.receivedAt}>{dateTime(sourceEmail.receivedAt)}</time>
          </span>
        </div>
        <Link
          className="button textButton"
          to={`/mailbox?${new URLSearchParams({ label: 'inbox', email: sourceEmail.id })}`}
        >
          Open customer mail
        </Link>
      </header>
      <ul className="rfqCardRequests">
        {group.rfqs.map((item) => (
          <li key={item.rfq.id}>
            <RfqRequestRow
              item={item}
              vendors={vendors}
              session={session}
              onSignedOut={onSignedOut}
              repeated={group.rfqs.length > 1}
            />
          </li>
        ))}
      </ul>
    </article>
  );
}

function RfqRequestRow({
  item,
  vendors,
  session,
  onSignedOut,
  repeated,
}: {
  item: RfqListItemResponse;
  vendors: VendorResponse[];
  session: SessionResponse;
  onSignedOut: () => void;
  /** True when the customer mail has more than one request: each row then says when it was sent. */
  repeated: boolean;
}) {
  const [open, setOpen] = useState(false);
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const pill = rfqProgressPill(item);
  const details = useQuery({
    queryKey: ['rfq', session.tenantId, session.mailboxId, item.rfq.id],
    queryFn: ({ signal }) => frontendApi.rfq(session, item.rfq.id, signal),
    enabled: open,
    // Collapse and expand is the refresh gesture: every open re-reads, the old rows stay until the new land.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const expired = isUnauthenticated(details.error);
  useEffect(() => {
    if (expired) onSignedOut();
  }, [expired, onSignedOut]);
  const detailsId = `rfq-details-${item.rfq.id}`;
  return (
    <div className="rfqRequest">
      <div className="rfqRequestSummary">
        <div className="rfqRequestRoute">
          <strong>{formatRoute(item.rfq)}</strong>
          <span className="muted">
            {repeated ? 'Sent ' : 'Requested '}
            <time dateTime={item.rfq.createdAt}>{dateTime(item.rfq.createdAt)}</time>
            {' · '}
            {item.replies.contactCount === 1
              ? '1 vendor contact'
              : `${item.replies.contactCount} vendor contacts`}
          </span>
        </div>
        <span className={`rfqProgressPill ${pill.tone}`}>{pill.label}</span>
        <button
          type="button"
          className="button textButton"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown size={16} aria-hidden="true" className={open ? 'rotated' : undefined} />
          {open ? 'Hide vendor replies' : 'View vendor replies'}
        </button>
      </div>
      {open && (
        <div id={detailsId} className="rfqRequestDetails">
          {details.isPending ? (
            <p className="rfqSuggestionStatus" role="status">
              <RefreshCw size={16} aria-hidden="true" className="spinning" />
              Loading vendor replies…
            </p>
          ) : details.isError && !details.data ? (
            <p className="inlineAlert" role="alert">
              Vendor replies could not be loaded. {errorMessage(details.error)}{' '}
              <button
                type="button"
                className="button textButton"
                onClick={() => void details.refetch()}
              >
                Try again
              </button>
            </p>
          ) : details.data ? (
            <>
              {details.isError && (
                <p className="inlineAlert" role="alert">
                  Refresh failed; showing the last read. {errorMessage(details.error)}
                </p>
              )}
              <RfqSendStatus
                mails={details.data.mails}
                vendors={vendors}
                headingId={`rfq-send-status-${item.rfq.id}`}
                headingRef={statusHeading}
                polling={details.isFetching}
                retrying={false}
                onRetry={null}
              />
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
