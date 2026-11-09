import { Check, Link2, TriangleAlert } from 'lucide-react';
import type { ConnectFlowErrorCode, MailboxResponse } from '@lc/contract';
import { connectFlowErrorSchema } from '@lc/contract';

const failureReasons: Record<ConnectFlowErrorCode, string> = {
  denied: 'Google access was cancelled. Try again and allow access to your mailbox.',
  invalid_state: 'This connection link has expired. Start a new connection below.',
  google_client_not_configured:
    'Google setup is not complete. Ask your workspace administrator to finish it.',
  exchange_failed: 'Google could not complete the connection. Please try again.',
  email_mismatch: 'The Google account you chose does not match this mailbox.',
  scope_not_granted:
    'Mail access was not granted. Try again and allow the requested Gmail permissions.',
  pubsub_not_configured:
    'Mail notifications are not configured. Ask your workspace administrator to finish setup.',
  watch_failed:
    'Google could not enable mail notifications. Ask your workspace administrator to check setup.',
};

export function ConnectionPanel({
  mailbox,
  outcome,
  connecting,
  connectError,
  onConnect,
  onContinue,
}: {
  mailbox: MailboxResponse;
  outcome: { connected?: boolean; error?: string };
  connecting: boolean;
  connectError?: string;
  onConnect: () => void;
  onContinue: () => void;
}) {
  const isConnected = mailbox.gmailConnectionStatus === 'connected';
  const success = outcome.connected && isConnected;
  const failed = Boolean(outcome.error) || (outcome.connected && !isConnected);
  const errorCode = connectFlowErrorSchema.safeParse(outcome.error);
  const reason = outcome.error
    ? errorCode.success
      ? failureReasons[errorCode.data]
      : 'The connection did not finish. Please try again.'
    : 'We could not confirm a connected mailbox. Start the connection again.';
  return (
    <section className="connectionPanel" aria-labelledby="connection-title">
      <span className={`connectionIcon ${failed ? 'warning' : ''}`}>
        {success ? (
          <Check size={28} aria-hidden="true" />
        ) : failed ? (
          <TriangleAlert size={28} aria-hidden="true" />
        ) : (
          <Link2 size={28} aria-hidden="true" />
        )}
      </span>
      <p className="eyebrow">Gmail connection</p>
      <h1 id="connection-title">
        {success ? 'Connection successful' : failed ? 'Connection failed' : 'Connect your mailbox'}
      </h1>
      <p>
        {success
          ? 'Your mailbox is connected. New mail will appear here as it arrives.'
          : failed
            ? reason
            : 'Connect Gmail to bring new conversations into your workspace. Older mail is not imported.'}
      </p>
      <div className="mailboxIdentity">
        <span>
          {failed && outcome.error === 'email_mismatch'
            ? 'Use this Google account'
            : 'Your mailbox'}
        </span>
        <strong>{mailbox.emailAddress}</strong>
      </div>
      {connectError && (
        <p className="formError" role="alert">
          {connectError}
        </p>
      )}
      <div className="connectionActions">
        {success ? (
          <button className="button primary" onClick={onContinue}>
            Continue to mailbox
          </button>
        ) : (
          <button
            className="button primary"
            aria-disabled={connecting}
            onClick={() => {
              if (!connecting) onConnect();
            }}
          >
            {connecting ? 'Opening Google…' : failed ? 'Try again' : 'Connect Gmail'}
          </button>
        )}
        {!success && (
          <button className="button textButton" onClick={onContinue}>
            View stored mail
          </button>
        )}
      </div>
      {!success && <p className="finePrint">You will continue on Google to approve access.</p>}
    </section>
  );
}
