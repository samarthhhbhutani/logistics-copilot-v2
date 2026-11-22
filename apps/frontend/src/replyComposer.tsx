import { useEffect, useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import type { EmailDetailResponse, SentMailResponse, SessionResponse } from '@lc/contract';
import { MAX_REPLY_TEXT_LENGTH } from '@lc/contract';
import { errorMessage, frontendApi, FrontendApiError, isUnauthenticated } from './frontendApi.js';
import { describeSentMailStatus } from './rfqSend.js';

/** The mail a reply answers: the thread's newest inbound message (`emails` arrive oldest first). */
export function newestInboundEmail(emails: EmailDetailResponse[]): EmailDetailResponse | undefined {
  for (let index = emails.length - 1; index >= 0; index -= 1) {
    if (emails[index]?.gmailLabel === 'inbox') return emails[index];
  }
  return undefined;
}

/**
 * Writes a plain-text reply to one inbound mail and sends it from the operator's mailbox; the API
 * adds the subject, the recipients, the threading headers and the mailbox signature.
 *
 * `sentMailId` is the idempotency key the API expects: it is kept across a retry of a request that
 * never answered (the same id can only ever produce one mail) and replaced after a `failed` answer
 * (the failed row keeps the old id). A `sending` answer means Gmail may have taken the mail: the
 * text freezes and "Check status" repeats the same POST, which the API answers with the row as it
 * stands rather than sending again.
 */
export function ReplyComposer({
  email,
  session,
  onSignedOut,
}: {
  email: EmailDetailResponse;
  session: SessionResponse;
  onSignedOut: () => void;
}) {
  const headingId = useId();
  const textareaId = useId();
  const statusLine = useRef<HTMLParagraphElement>(null);
  const [bodyText, setBodyText] = useState('');
  const [sentMailId, setSentMailId] = useState(() => crypto.randomUUID());
  const [sentMail, setSentMail] = useState<SentMailResponse | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (text: string) => frontendApi.sendReply(session, email.id, { sentMailId, text }),
    onSuccess: (mail) => {
      setSentMail(mail);
      // The failed row keeps this id; the next attempt needs its own.
      if (mail.status === 'failed') setSentMailId(crypto.randomUUID());
    },
    onError: (error) => {
      if (error instanceof FrontendApiError && error.code === 'sent_mail_id_taken') {
        setSentMailId(crypto.randomUUID());
      }
    },
    retry: false,
  });
  const expired = isUnauthenticated(send.error);
  useEffect(() => {
    if (expired) onSignedOut();
  }, [expired, onSignedOut]);
  const outcome = sentMail ? describeSentMailStatus(sentMail) : null;
  const outcomeShown = outcome !== null || send.isError;
  // The outcome replaces the button the operator just pressed: read it out and move focus to it.
  useEffect(() => {
    if (outcomeShown && !send.isPending) statusLine.current?.focus();
  }, [outcomeShown, send.isPending, sentMail]);

  /** Frozen once the text is with Gmail, or may be: editing it then would not change what went out. */
  const handedOff = sentMail?.status === 'sent' || sentMail?.status === 'sending';
  const recipient = email.sender.name
    ? `${email.sender.name} <${email.sender.email ?? ''}>`
    : (email.sender.email ?? 'the sender');

  /** Sends, or for a mail still `sending` repeats the same request to see where it stands. */
  function submit() {
    if (send.isPending || sentMail?.status === 'sent') return;
    const text = bodyText.trim();
    if (!text) {
      setValidationMessage('Write the reply before sending.');
      return;
    }
    setValidationMessage(null);
    send.mutate(text);
  }

  function startAnother() {
    setSentMailId(crypto.randomUUID());
    setSentMail(null);
    setBodyText('');
    setValidationMessage(null);
    send.reset();
  }

  const buttonLabel = send.isPending
    ? sentMail?.status === 'sending'
      ? 'Checking…'
      : 'Sending…'
    : sentMail?.status === 'sending'
      ? 'Check status'
      : sentMail?.status === 'failed' || send.isError
        ? 'Try again'
        : 'Send reply';

  return (
    <section className="replyComposer" aria-labelledby={headingId}>
      <h2 id={headingId}>Reply</h2>
      <p className="muted">
        To {recipient}, in this conversation. Your signature is added when it is sent.
      </p>
      <div className="replyField">
        <label htmlFor={textareaId}>Message</label>
        <textarea
          id={textareaId}
          rows={8}
          maxLength={MAX_REPLY_TEXT_LENGTH}
          value={bodyText}
          disabled={handedOff || send.isPending}
          aria-invalid={validationMessage ? true : undefined}
          onChange={(event) => {
            setBodyText(event.target.value);
            if (validationMessage) setValidationMessage(null);
          }}
        />
        {validationMessage && (
          <p className="formError" role="alert">
            {validationMessage}
          </p>
        )}
      </div>
      <div className="replyComposerActions">
        {sentMail?.status !== 'sent' && (
          <button className="button" aria-disabled={send.isPending} onClick={submit}>
            {send.isPending ? (
              <RefreshCw size={16} aria-hidden="true" className="spinning" />
            ) : (
              <Send size={16} aria-hidden="true" />
            )}
            {buttonLabel}
          </button>
        )}
        {handedOff && !send.isPending && (
          <button className="button secondary" onClick={startAnother}>
            Write another reply
          </button>
        )}
      </div>
      {send.isError && !expired ? (
        <p className="inlineAlert" role="alert" ref={statusLine} tabIndex={-1}>
          <TriangleAlert size={16} aria-hidden="true" />
          Reply not sent. {errorMessage(send.error)}
          {!(send.error instanceof FrontendApiError) &&
            ' Trying again is safe: the same reply is never sent twice.'}
        </p>
      ) : outcome?.tone === 'sent' ? (
        <p className="replyOutcome sent" role="status" ref={statusLine} tabIndex={-1}>
          <Check size={16} aria-hidden="true" />
          Reply sent to {email.sender.email}.
        </p>
      ) : outcome?.tone === 'failed' ? (
        <p className="inlineAlert" role="alert" ref={statusLine} tabIndex={-1}>
          <TriangleAlert size={16} aria-hidden="true" />
          Reply not sent. {outcome.detail}
        </p>
      ) : outcome ? (
        <p className="replyOutcome" role="status" ref={statusLine} tabIndex={-1}>
          <RefreshCw
            size={16}
            aria-hidden="true"
            className={send.isPending ? 'spinning' : undefined}
          />
          {outcome.detail}
        </p>
      ) : null}
    </section>
  );
}
