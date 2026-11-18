import { useEffect } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileText, RefreshCw, TriangleAlert } from 'lucide-react';
import type { SessionResponse } from '@lc/contract';
import { errorMessage, frontendApi, isUnauthenticated } from './frontendApi.js';
import { RfqCustomerMailCard } from './rfqCard.js';
import { mergeCustomerMailPages } from './rfqList.js';
import { WorkspaceShell } from './workspaceShell.js';

/**
 * Every request for vendor quotes the desk has sent, newest first, one card per customer mail. The
 * list is read a page at a time ("Load more"); counts on the cards come from the list, the vendor
 * rows from GET /rfqs/:rfqId when a request is expanded.
 */
export function RfqsPage({
  session,
  onSignedOut,
  sessionError,
}: {
  session: SessionResponse;
  onSignedOut: () => void;
  sessionError?: string;
}) {
  const mailbox = useQuery({
    queryKey: ['mailbox', session.tenantId, session.mailboxId],
    queryFn: ({ signal }) => frontendApi.mailbox(session, signal),
  });
  const rfqPages = useInfiniteQuery({
    queryKey: ['rfqs', session.tenantId, session.mailboxId],
    queryFn: ({ pageParam, signal }) => frontendApi.rfqs(session, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const vendors = useQuery({
    queryKey: ['vendors', session.tenantId, session.mailboxId],
    queryFn: ({ signal }) => frontendApi.vendors(session, signal),
    staleTime: 60_000,
  });
  const expired = [mailbox.error, rfqPages.error, vendors.error].some(isUnauthenticated);
  useEffect(() => {
    if (expired) onSignedOut();
  }, [expired, onSignedOut]);
  useEffect(() => {
    document.title = 'Vendor quotes · Logistics Copilot';
  }, []);
  if (expired)
    return (
      <main className="pageStatus" role="status">
        Returning to sign in…
      </main>
    );
  const groups = rfqPages.data ? mergeCustomerMailPages(rfqPages.data.pages) : [];
  const requestCount = groups.reduce((count, group) => count + group.rfqs.length, 0);
  return (
    <WorkspaceShell
      pageTitle="Vendor quotes"
      accountAddress={mailbox.data?.emailAddress}
      sessionError={sessionError}
      onSignedOut={onSignedOut}
    >
      <div className="mailHeading">
        <div>
          <p className="eyebrow">Your requests</p>
          <h1>Vendor quotes</h1>
          <p className="muted">Every request for rates you sent, and which vendors came back.</p>
        </div>
        <button
          className="button secondary"
          onClick={() => {
            if (!rfqPages.isFetching) void rfqPages.refetch();
          }}
          aria-disabled={rfqPages.isFetching}
        >
          <RefreshCw
            className={rfqPages.isFetching ? 'spinning' : undefined}
            size={16}
            aria-hidden="true"
          />
          {rfqPages.isFetching && !rfqPages.isFetchingNextPage ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {rfqPages.isError && rfqPages.data && (
        <p className="inlineAlert" role="alert">
          Refresh failed. Showing the last read. {errorMessage(rfqPages.error)}
        </p>
      )}
      {vendors.isError && !isUnauthenticated(vendors.error) && (
        <p className="inlineAlert" role="alert">
          Vendor names could not be loaded; rows show contact addresses only.
        </p>
      )}
      <section
        className="rfqCards"
        aria-label="Requests for vendor quotes"
        aria-busy={rfqPages.isFetching}
      >
        {rfqPages.isPending ? (
          <div className="pageStatus" role="status">
            Loading your requests…
          </div>
        ) : rfqPages.isError && !rfqPages.data ? (
          <div className="emptyState">
            <TriangleAlert size={30} aria-hidden="true" />
            <h2>Requests could not be loaded</h2>
            <p role="alert">{errorMessage(rfqPages.error)}</p>
            <button className="button secondary" onClick={() => void rfqPages.refetch()}>
              Try again
            </button>
          </div>
        ) : groups.length === 0 ? (
          <div className="emptyState">
            <FileText size={34} aria-hidden="true" />
            <h2>No vendor quotes requested yet</h2>
            <p>
              Open a customer request in your inbox and use "Request vendor quotes" to send one.
            </p>
            <Link className="button secondary" to="/mailbox?label=inbox">
              Go to inbox
            </Link>
          </div>
        ) : (
          groups.map((group) => (
            <RfqCustomerMailCard
              key={group.sourceEmail.id}
              group={group}
              vendors={vendors.data?.vendors ?? []}
              session={session}
              onSignedOut={onSignedOut}
            />
          ))
        )}
      </section>
      {rfqPages.data && groups.length > 0 && (
        <footer className="mailFooter">
          <span>
            {requestCount === 1 ? '1 request' : `${requestCount} requests`} from{' '}
            {groups.length === 1 ? '1 customer mail' : `${groups.length} customer mails`} shown
          </span>
          {rfqPages.hasNextPage && (
            <button
              className="button secondary"
              aria-disabled={rfqPages.isFetchingNextPage}
              onClick={() => {
                if (!rfqPages.isFetchingNextPage) void rfqPages.fetchNextPage();
              }}
            >
              {rfqPages.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </footer>
      )}
    </WorkspaceShell>
  );
}
