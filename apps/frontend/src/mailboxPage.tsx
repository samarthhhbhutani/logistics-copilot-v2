import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Inbox, Link2, RefreshCw, TriangleAlert } from 'lucide-react';
import type { SessionResponse } from '@lc/contract';
import { ThreadView } from './threadView.js';
import { ClassificationBadge } from './classificationBadge.js';
import { ConnectionPanel } from './connectionPanel.js';
import { errorMessage, isUnauthenticated, frontendApi } from './frontendApi.js';
import type { MailListFilter } from './frontendApi.js';
import { WorkspaceShell, mailFolderFor, mailListFilterParams } from './workspaceShell.js';

export function MailboxPage({
  session,
  onSignedOut,
  sessionError,
}: {
  session: SessionResponse;
  onSignedOut: () => void;
  sessionError?: string;
}) {
  const [redirecting, setRedirecting] = useState(false);
  const connectController = useRef<AbortController | null>(null);
  useEffect(() => () => connectController.current?.abort(), []);
  useEffect(() => {
    function resumeFromBrowserCache(event: PageTransitionEvent) {
      if (event.persisted) setRedirecting(false);
    }
    window.addEventListener('pageshow', resumeFromBrowserCache);
    return () => window.removeEventListener('pageshow', resumeFromBrowserCache);
  }, []);
  const [searchParams, setSearchParams] = useSearchParams();
  const folder = mailFolderFor(searchParams);
  const { filter } = folder;
  const filterParams = mailListFilterParams(filter);
  const cursor = searchParams.get('cursor') || undefined;
  const selectedEmailId = searchParams.get('email');
  const outcome = {
    connected: searchParams.get('connected') === '1',
    error: searchParams.get('error') || undefined,
  };
  const isOutcomePage = outcome.connected || Boolean(outcome.error);
  const isSetupPage = searchParams.get('setup') === '1';
  const mailbox = useQuery({
    queryKey: ['mailbox', session.tenantId, session.mailboxId],
    queryFn: ({ signal }) => frontendApi.mailbox(session, signal),
  });
  const emails = useQuery({
    queryKey: ['emails', session.tenantId, session.mailboxId, filter, cursor],
    queryFn: ({ signal }) => frontendApi.emails(session, filter, cursor, signal),
    enabled: Boolean(mailbox.data) && !isOutcomePage && !isSetupPage && !selectedEmailId,
  });
  const connect = useMutation({
    mutationFn: () => {
      connectController.current = new AbortController();
      return frontendApi.connect(connectController.current.signal);
    },
    onSuccess: ({ url }) => {
      if (connectController.current?.signal.aborted) return;
      setRedirecting(true);
      window.location.assign(url);
    },
  });
  const connecting = connect.isPending || redirecting;
  const expired = [mailbox.error, emails.error, connect.error].some(isUnauthenticated);
  useEffect(() => {
    if (expired) onSignedOut();
  }, [expired, onSignedOut]);
  useEffect(() => {
    if (!selectedEmailId) document.title = `${folder.title} · Logistics Copilot`;
  }, [folder.title, selectedEmailId]);
  function showNewestMail(nextFilter: MailListFilter) {
    setSearchParams(mailListFilterParams(nextFilter));
  }
  function openNextPage(nextCursor: string) {
    setSearchParams({ ...filterParams, cursor: nextCursor });
    window.scrollTo({ top: 0 });
  }
  function showConnection() {
    setSearchParams({ ...filterParams, setup: '1' });
  }
  function refresh() {
    if (emails.isFetching || mailbox.isFetching) return;
    void mailbox.refetch();
    void emails.refetch();
  }
  if (expired)
    return (
      <main className="pageStatus" role="status">
        Returning to sign in…
      </main>
    );
  return (
    <WorkspaceShell
      pageTitle="Mailbox"
      accountAddress={mailbox.data?.emailAddress}
      sessionError={sessionError}
      onSignedOut={onSignedOut}
      // A sign-out must not race a Google redirect the connect button started.
      onSignOutStarted={() => connectController.current?.abort()}
    >
      <>
        {mailbox.isError && mailbox.data && (
          <p className="inlineAlert" role="alert">
            Mailbox refresh failed. Showing saved data. {errorMessage(mailbox.error)}
          </p>
        )}
        {mailbox.isPending ? (
          <div className="pageStatus" role="status">
            Opening your mailbox…
          </div>
        ) : !mailbox.data ? (
          <div className="emptyState">
            <TriangleAlert size={30} aria-hidden="true" />
            <h1>Mailbox unavailable</h1>
            <p role="alert">{errorMessage(mailbox.error)}</p>
            <button className="button secondary" onClick={() => void mailbox.refetch()}>
              Try again
            </button>
          </div>
        ) : (
          <>
            {isOutcomePage || isSetupPage ? (
              <ConnectionPanel
                mailbox={mailbox.data}
                outcome={outcome}
                connecting={connecting}
                connectError={connect.error ? errorMessage(connect.error) : undefined}
                onConnect={() => {
                  if (!connecting) connect.mutate();
                }}
                onContinue={() => showNewestMail(filter)}
              />
            ) : selectedEmailId ? (
              <ThreadView
                key={selectedEmailId}
                emailId={selectedEmailId}
                session={session}
                onSignedOut={onSignedOut}
                backTo={`/mailbox${Object.keys(filterParams).length || cursor ? `?${new URLSearchParams({ ...filterParams, ...(cursor ? { cursor } : {}) })}` : ''}`}
                backLabel={folder.title}
              />
            ) : (
              <>
                <div className="mailHeading">
                  <div>
                    <p className="eyebrow">Your conversations</p>
                    <h1>{folder.title}</h1>
                    <p className="muted">A clear view of your mailbox.</p>
                  </div>
                  <button
                    className="button secondary"
                    onClick={refresh}
                    aria-disabled={emails.isFetching || mailbox.isFetching}
                  >
                    <RefreshCw
                      className={emails.isFetching ? 'spinning' : undefined}
                      size={16}
                      aria-hidden="true"
                    />
                    {emails.isFetching ? 'Refreshing…' : 'Refresh'}
                  </button>
                </div>
                {mailbox.data.gmailConnectionStatus !== 'connected' ? (
                  <section className="connectionBanner" aria-label="Gmail connection">
                    <Link2 size={20} aria-hidden="true" />
                    <div>
                      <strong>
                        {mailbox.data.gmailConnectionStatus === 'needs_reconnect'
                          ? 'Reconnect Gmail to receive new mail'
                          : 'Connect Gmail to start receiving mail'}
                      </strong>
                      <p>
                        {mailbox.data.gmailConnectionStatus === 'needs_reconnect'
                          ? 'Google access has expired. Your stored mail is still available below.'
                          : 'New mail appears here after you connect. Older mail is not imported.'}
                      </p>
                    </div>
                    <button className="button secondary" onClick={showConnection}>
                      {mailbox.data.gmailConnectionStatus === 'needs_reconnect'
                        ? 'Reconnect Gmail'
                        : 'Connect Gmail'}
                    </button>
                  </section>
                ) : (
                  <div className="connectionStatus">
                    <span className="statusDot" />
                    <span>Gmail connected</span>
                    <span className="connectionStatusDetail">
                      Mail stored for this mailbox only
                    </span>
                  </div>
                )}
                {emails.isError && emails.data && (
                  <p className="inlineAlert" role="alert">
                    Mail refresh failed. Showing saved messages. {errorMessage(emails.error)}
                  </p>
                )}
                <section
                  className="mailList"
                  aria-label={`${folder.title} messages`}
                  aria-busy={emails.isFetching}
                >
                  <div className="listHeader">
                    <span>Conversation</span>
                    <span>Received</span>
                  </div>
                  {emails.isPending ? (
                    <div role="status" className="mailSkeletons">
                      <span className="srOnly">Loading messages…</span>
                      {[0, 1, 2, 3].map((index) => (
                        <div className="mailSkeleton" key={index} aria-hidden="true">
                          <i />
                          <div>
                            <i />
                            <i />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : emails.isError && !emails.data ? (
                    <div className="emptyState">
                      <TriangleAlert size={30} aria-hidden="true" />
                      <h2>Mail could not be loaded</h2>
                      <p role="alert">{errorMessage(emails.error)}</p>
                      <div className="connectionActions">
                        <button className="button secondary" onClick={() => void emails.refetch()}>
                          Try again
                        </button>
                        {cursor && (
                          <button
                            className="button textButton"
                            onClick={() => showNewestMail(filter)}
                          >
                            Newest mail
                          </button>
                        )}
                      </div>
                    </div>
                  ) : emails.data?.emails.length ? (
                    <ul className="emailRows">
                      {emails.data.emails.map((email) => {
                        const sender =
                          email.gmailLabel === 'sent'
                            ? email.toRecipients
                                .map((recipient) => recipient.name || recipient.address)
                                .join(', ') || 'Undisclosed recipients'
                            : email.sender.name || email.sender.email || 'Unknown sender';
                        return (
                          <li key={email.id}>
                            <Link
                              className="emailRow"
                              to={{
                                pathname: '/mailbox',
                                search: `?${new URLSearchParams({ ...filterParams, ...(cursor ? { cursor } : {}), email: email.id })}`,
                              }}
                            >
                              <span
                                className={`senderAvatar ${email.gmailLabel === 'sent' ? 'sentAvatar' : ''}`}
                                aria-hidden="true"
                              >
                                {sender.slice(0, 1).toUpperCase()}
                              </span>
                              <div className="emailSummary">
                                <div className="emailSender">
                                  <span title={sender}>
                                    {email.gmailLabel === 'sent' ? `To: ${sender}` : sender}
                                  </span>
                                  <span className="mailLabel">
                                    {email.gmailLabel === 'sent' ? 'Sent' : 'Inbox'}
                                  </span>
                                </div>
                                <div className="emailSubjectLine">
                                  <p className="emailSubject">{email.subject || '(No subject)'}</p>
                                  {email.classification ? (
                                    <ClassificationBadge label={email.classification.label} />
                                  ) : (
                                    <span className="classificationBadge classificationUnassigned">
                                      {email.gmailLabel === 'sent'
                                        ? 'Not classified'
                                        : 'Not classified yet'}
                                    </span>
                                  )}
                                </div>
                                <p className="emailSnippet">
                                  {email.snippet || 'No preview available'}
                                </p>
                              </div>
                              <time
                                dateTime={email.receivedAt}
                                title={new Date(email.receivedAt).toLocaleString()}
                              >
                                {new Intl.DateTimeFormat(undefined, {
                                  month: 'short',
                                  day: 'numeric',
                                }).format(new Date(email.receivedAt))}
                              </time>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="emptyState">
                      <Inbox size={34} aria-hidden="true" />
                      <h2>
                        {cursor
                          ? 'No more messages'
                          : filter.label === 'sent'
                            ? 'No sent mail yet'
                            : filter.classification === 'customer_request'
                              ? 'No customer requests yet'
                              : 'Room for your next conversation'}
                      </h2>
                      <p>
                        {cursor
                          ? 'Return to the newest mail to see recent conversations.'
                          : mailbox.data.gmailConnectionStatus !== 'connected'
                            ? 'Connect Gmail above. New messages will appear here when they arrive.'
                            : filter.label === 'sent'
                              ? 'Mail you send from Gmail after connecting will appear here.'
                              : filter.classification === 'customer_request'
                                ? 'Inbound mail the classifier marks as a customer request will appear here.'
                                : 'New messages will appear here after Gmail delivers them. Use Refresh to check again.'}
                      </p>
                      {cursor && (
                        <button className="button secondary" onClick={() => showNewestMail(filter)}>
                          Newest mail
                        </button>
                      )}
                    </div>
                  )}
                </section>
                <footer className="mailFooter">
                  <span>
                    {emails.data
                      ? `${emails.data.emails.length} messages on this page`
                      : 'Mailbox preview'}
                    <span className="footerNote">Open a message to read its conversation.</span>
                  </span>
                  <div className="pagination">
                    {cursor && (
                      <button className="button textButton" onClick={() => showNewestMail(filter)}>
                        <ArrowLeft size={16} aria-hidden="true" />
                        Newest
                      </button>
                    )}
                    <button
                      className="button secondary"
                      aria-disabled={!emails.data?.nextCursor || emails.isFetching}
                      onClick={() => {
                        if (emails.data?.nextCursor && !emails.isFetching)
                          openNextPage(emails.data.nextCursor);
                      }}
                    >
                      Older
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  </div>
                </footer>
              </>
            )}
          </>
        )}
      </>
    </WorkspaceShell>
  );
}
