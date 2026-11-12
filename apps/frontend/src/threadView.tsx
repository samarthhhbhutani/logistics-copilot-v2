import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronDown, RefreshCw } from 'lucide-react';
import type { ClassificationSource, EmailDetailResponse, SessionResponse } from '@lc/contract';
import { errorMessage, frontendApi, FrontendApiError, isUnauthenticated } from './frontendApi.js';
import { MessageAttachments } from './messageAttachments.js';
import { ClassificationBadge } from './classificationBadge.js';
import { EmailBody } from './emailBody.js';

const sourceTitles: Record<ClassificationSource, string> = {
  thread: 'From this conversation',
  rule: 'Sender rule',
  llm: 'AI classification',
  user: 'Operator correction',
};

export function ThreadView({
  emailId,
  session,
  onSignedOut,
  backTo,
  backLabel,
}: {
  emailId: string;
  session: SessionResponse;
  onSignedOut: () => void;
  backTo: string;
  backLabel: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const thread = useQuery({
    queryKey: ['thread', session.tenantId, session.mailboxId, emailId],
    queryFn: ({ signal }) => frontendApi.thread(session, emailId, signal),
  });
  const expired = isUnauthenticated(thread.error);
  const missing = thread.error instanceof FrontendApiError && thread.error.status === 404;
  const subject =
    thread.data?.emails.find((email) => email.id === emailId)?.subject || '(No subject)';
  useEffect(() => {
    if (expired) onSignedOut();
  }, [expired, onSignedOut]);
  const loaded = Boolean(thread.data);
  useEffect(() => {
    document.title = `${loaded ? subject : 'Conversation'} · Logistics Copilot`;
  }, [loaded, subject]);
  useEffect(() => {
    if (loaded) heading.current?.focus();
  }, [loaded]);
  if (expired)
    return (
      <div className="pageStatus" role="status">
        Returning to sign in…
      </div>
    );
  return (
    <section className="threadView" aria-label="Conversation">
      <div className="threadToolbar">
        <Link className="button textButton" to={backTo}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back to {backLabel}
        </Link>
        <button
          className="button secondary"
          aria-disabled={thread.isFetching}
          onClick={() => {
            if (!thread.isFetching) void thread.refetch();
          }}
        >
          <RefreshCw
            size={16}
            aria-hidden="true"
            className={thread.isFetching ? 'spinning' : undefined}
          />
          {thread.isFetching ? 'Refreshing…' : 'Refresh conversation'}
        </button>
      </div>
      {thread.isPending ? (
        <div className="pageStatus" role="status">
          Opening conversation…
        </div>
      ) : missing || !thread.data ? (
        <div className="emptyState">
          <h1>{missing ? 'Conversation unavailable' : 'Conversation could not be loaded'}</h1>
          <p role="alert">{errorMessage(thread.error)}</p>
          {!missing && (
            <button className="button secondary" onClick={() => void thread.refetch()}>
              Try again
            </button>
          )}
        </div>
      ) : (
        <>
          <header className="threadHeading">
            <p className="eyebrow">Conversation</p>
            <h1 ref={heading} tabIndex={-1}>
              {subject}
            </h1>
            <p className="muted">
              {thread.data.emails.length} {thread.data.emails.length === 1 ? 'message' : 'messages'}{' '}
              · Latest first · Stored mail only
            </p>
          </header>
          {thread.isError && (
            <p className="inlineAlert" role="alert">
              Conversation refresh failed. Showing saved messages. {errorMessage(thread.error)}
            </p>
          )}
          <ol className="threadMessages">
            {[...thread.data.emails].reverse().map((email, index) => (
              <li key={email.id}>
                <ThreadMessage
                  email={email}
                  session={session}
                  onSignedOut={onSignedOut}
                  initiallyOpen={index === 0 || email.id === emailId}
                />
              </li>
            ))}
          </ol>
          <p className="threadFootnote">
            Remote images load automatically and may notify the sender. Messages may include quoted
            history. This conversation contains only messages already stored in your mailbox.
          </p>
        </>
      )}
    </section>
  );
}

function ThreadMessage({
  email,
  session,
  onSignedOut,
  initiallyOpen,
}: {
  email: EmailDetailResponse;
  session: SessionResponse;
  onSignedOut: () => void;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [showFiles, setShowFiles] = useState(false);
  const classification = email.classification;
  const sender = email.sender.name || email.sender.email || 'Unknown sender';
  return (
    <details
      className="threadMessage"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="messageSummary">
        <span
          className={`senderAvatar ${email.gmailLabel === 'sent' ? 'sentAvatar' : ''}`}
          aria-hidden="true"
        >
          {sender.slice(0, 1).toUpperCase()}
        </span>
        <span className="messageIdentity">
          <strong>{sender}</strong>
          <span>{email.sender.email || 'No sender address'}</span>
        </span>
        <span className="messageTime">
          <span className="mailLabel">{email.gmailLabel === 'sent' ? 'Sent' : 'Inbox'}</span>
          <time dateTime={email.receivedAt}>
            {new Date(email.receivedAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </time>
        </span>
        <ChevronDown className="messageChevron" size={18} aria-hidden="true" />
      </summary>
      {open && (
        <div className="messageContent">
          <dl className="messageRecipients">
            <dt>To</dt>
            <dd>
              {email.toRecipients
                .map((recipient) =>
                  recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address,
                )
                .join(', ') || 'Undisclosed recipients'}
            </dd>
            {email.ccRecipients.length > 0 && (
              <>
                <dt>Cc</dt>
                <dd>
                  {email.ccRecipients
                    .map((recipient) =>
                      recipient.name
                        ? `${recipient.name} <${recipient.address}>`
                        : recipient.address,
                    )
                    .join(', ')}
                </dd>
              </>
            )}
          </dl>
          <div className="messageClassification">
            {classification ? (
              <>
                <ClassificationBadge label={classification.label} />
                <span>
                  {sourceTitles[classification.source]}
                  {classification.source === 'llm' && classification.confidence !== null
                    ? ` · ${Math.round(classification.confidence * 100)}% confidence`
                    : ''}
                </span>
              </>
            ) : (
              <span>
                {email.gmailLabel === 'sent'
                  ? 'Outbound mail is not classified'
                  : 'Not classified yet'}
              </span>
            )}
          </div>
          <EmailBody email={email} session={session} onSignedOut={onSignedOut} />
          <div className="messageFiles">
            <button
              className="button textButton"
              aria-expanded={showFiles}
              onClick={() => setShowFiles(!showFiles)}
            >
              {showFiles ? 'Hide files' : 'Show files'}
            </button>
            {showFiles && (
              <MessageAttachments emailId={email.id} session={session} onSignedOut={onSignedOut} />
            )}
          </div>
        </div>
      )}
    </details>
  );
}
