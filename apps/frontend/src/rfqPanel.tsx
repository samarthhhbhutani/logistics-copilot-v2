import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  MAX_RFQ_MAIL_BODY_LENGTH,
  MAX_RFQ_MAIL_SUBJECT_LENGTH,
  SUGGESTED_CONTAINER_TYPES,
} from '@lc/contract';
import type {
  DraftRfqMailsResponse,
  EmailDetailResponse,
  FreightMode,
  OutboundAttachmentResponse,
  RfqDetails,
  RfqWithMailsResponse,
  SendRfqBody,
  SessionResponse,
  VendorCategory,
} from '@lc/contract';
import { errorMessage, frontendApi, isUnauthenticated } from './frontendApi.js';
import { OutboundAttachmentsField } from './outboundAttachmentsField.js';
import {
  VENDOR_CATEGORIES,
  categoriesOfRecipients,
  recipientsError,
  toRfqRecipients,
  vendorCategoryTitles,
} from './rfqRecipients.js';
import { RfqRecipientsPicker } from './rfqRecipientsPicker.js';
import { anyMailSending, mailTextsForSend, rfqProgressLabel } from './rfqSend.js';
import type { RfqMailDraftValues, RfqMailDrafts } from './rfqSend.js';
import { RfqRecord } from './rfqRecord.js';
import { RfqSendStatus } from './rfqSendStatus.js';
import {
  EMPTY_RFQ_DETAILS_FORM,
  freightModeTitles,
  parseRfqDetailsForm,
  rfqDetailsFieldLabels,
  rfqDetailsFormFromSuggestion,
} from './rfqDetailsForm.js';
import type {
  RfqDetailsField,
  RfqDetailsFormErrors,
  RfqDetailsFormValues,
} from './rfqDetailsForm.js';

const FREIGHT_MODES: FreightMode[] = ['sea_freight', 'air_freight', 'road'];
/** How often the panel re-reads the RFQ while a mail is still `sending`. */
const RFQ_STATUS_POLL_MS = 10_000;

function draftsFromResponse(response: DraftRfqMailsResponse): RfqMailDrafts {
  const drafts: RfqMailDrafts = {};
  for (const draft of response.drafts) {
    drafts[draft.category] = { subject: draft.subject, bodyText: draft.bodyText };
  }
  return drafts;
}

/**
 * "Request vendor quotes" on the opened inbox mail, whatever its classification (a misclassified
 * request must still be quotable): opens the RFQ details form prefilled by the model's reading of
 * that one message (not the conversation), for the operator to correct, with the desk's vendors to
 * tick underneath. The conversation view shows every message, so the form names the one it read.
 * "Write vendor mails" drafts one mail per vendor category for the operator to edit on the same
 * screen, and "Send" mails every ticked contact their category's text, one Gmail thread each. The
 * RFQ id is minted here when the panel opens, so the send and every retry of it are the same PUT;
 * once sent, the form freezes and the per-contact outcomes take over. Files attached under the drafts
 * go on every vendor mail and are fixed with the first send: the API stamps them on the RFQ, so a
 * retry carries them whether or not the body names them again. The id lives only in memory,
 * so on mount the panel asks the API for the newest RFQ sent from this mail: when there is one, a
 * second button says how many vendors replied and opens the record (RfqRecord); "Request vendor
 * quotes" stays beside it and opens a blank form for another request from the same mail.
 */
export function RfqPanel({
  email,
  session,
  onSignedOut,
}: {
  email: EmailDetailResponse;
  session: SessionResponse;
  onSignedOut: () => void;
}) {
  const [view, setView] = useState<'closed' | 'form' | 'record'>('closed');
  const open = view !== 'closed';
  const [values, setValues] = useState<RfqDetailsFormValues>(EMPTY_RFQ_DETAILS_FORM);
  const [prefilled, setPrefilled] = useState(false);
  const [errors, setErrors] = useState<RfqDetailsFormErrors>({});
  const [selectedContactIds, setSelectedContactIds] = useState<ReadonlySet<string>>(new Set());
  const [recipientsMessage, setRecipientsMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<RfqMailDrafts | null>(null);
  const [attachments, setAttachments] = useState<OutboundAttachmentResponse[]>([]);
  const [rfqId, setRfqId] = useState(() => crypto.randomUUID());
  const [sendResult, setSendResult] = useState<RfqWithMailsResponse | null>(null);
  const [sendMessage, setSendMessage] = useState<string | null>(null);
  const lastSendBody = useRef<SendRfqBody | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const draftsHeading = useRef<HTMLHeadingElement>(null);
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const queryClient = useQueryClient();

  const existingRfqKey = ['rfqBySourceEmail', session.tenantId, session.mailboxId, email.id];
  const existingRfq = useQuery({
    queryKey: existingRfqKey,
    queryFn: ({ signal }) => frontendApi.rfqBySourceEmail(session, email.id, signal),
    enabled: email.gmailLabel === 'inbox',
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data && anyMailSending(query.state.data.mails) ? RFQ_STATUS_POLL_MS : false,
  });
  const existingRecord = existingRfq.data ?? null;
  const suggestion = useQuery({
    queryKey: ['rfqSuggestion', session.tenantId, session.mailboxId, email.id],
    queryFn: ({ signal }) => frontendApi.rfqSuggestion(session, email.id, signal),
    // Only the form costs a model call; reading the record of an earlier request never does.
    enabled: view === 'form' && !prefilled,
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (suggestion.data && !prefilled) {
      setValues(rfqDetailsFormFromSuggestion(suggestion.data));
      setPrefilled(true);
    }
  }, [suggestion.data, prefilled]);
  const vendors = useQuery({
    queryKey: ['vendors', session.tenantId, session.mailboxId],
    queryFn: ({ signal }) => frontendApi.vendors(session, signal),
    enabled: open,
    staleTime: 60_000,
  });
  const writeDrafts = useMutation({
    mutationFn: ({ details, vendorIds }: { details: RfqDetails; vendorIds: string[] }) =>
      frontendApi.rfqDrafts(session, { sourceEmailId: email.id, details, vendorIds }),
    onSuccess: (response) => {
      setDrafts(draftsFromResponse(response));
      requestAnimationFrame(() => draftsHeading.current?.focus());
    },
    retry: false,
  });
  const rfqStatusKey = ['rfq', session.tenantId, session.mailboxId, rfqId];
  const sendRfq = useMutation({
    mutationFn: (body: SendRfqBody) => frontendApi.sendRfq(session, rfqId, body),
    onSuccess: (result) => {
      setSendResult(result);
      // The poll below continues from this answer rather than from an older read.
      queryClient.setQueryData(rfqStatusKey, result);
      // The newest RFQ for this mail is now this one: the collapsed label and a reload agree.
      queryClient.setQueryData(existingRfqKey, result);
    },
    retry: false,
  });
  const latestResult = queryClient.getQueryData<RfqWithMailsResponse>(rfqStatusKey) ?? sendResult;
  const rfqStatus = useQuery({
    queryKey: rfqStatusKey,
    queryFn: ({ signal }) => frontendApi.rfq(session, rfqId, signal),
    enabled: latestResult !== null && anyMailSending(latestResult.mails) && !sendRfq.isPending,
    refetchInterval: RFQ_STATUS_POLL_MS,
    staleTime: 0,
  });
  /** What this page load sent (and keeps polling); the form freezes under it. */
  const sentThisSession = rfqStatus.data ?? sendResult;
  /** An RFQ the API holds for this mail, offered as a record beside the form while nothing was sent here. */
  const recordOffered = sentThisSession === null && existingRecord !== null;
  const outcomesShown = view === 'record' || (view === 'form' && sentThisSession !== null);
  // The outcomes replace the Send button the operator just pressed (or the button they opened the
  // record with): move focus to them once mounted.
  useEffect(() => {
    if (outcomesShown) statusHeading.current?.focus();
  }, [outcomesShown]);
  useEffect(() => {
    if (
      isUnauthenticated(existingRfq.error) ||
      isUnauthenticated(suggestion.error) ||
      isUnauthenticated(vendors.error) ||
      isUnauthenticated(writeDrafts.error) ||
      isUnauthenticated(sendRfq.error) ||
      isUnauthenticated(rfqStatus.error)
    ) {
      onSignedOut();
    }
  }, [
    existingRfq.error,
    suggestion.error,
    vendors.error,
    writeDrafts.error,
    sendRfq.error,
    rfqStatus.error,
    onSignedOut,
  ]);

  if (email.gmailLabel !== 'inbox') return null;

  function update<Field extends RfqDetailsField>(field: Field, value: RfqDetailsFormValues[Field]) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  function updateDraft(category: VendorCategory, patch: Partial<RfqMailDraftValues>) {
    setDrafts((current) => {
      const draft = current?.[category];
      return draft ? { ...current, [category]: { ...draft, ...patch } } : current;
    });
  }

  function close() {
    if (writeDrafts.isPending || sendRfq.isPending) return;
    setView('closed');
    setErrors({});
    setRecipientsMessage(null);
    setSendMessage(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }

  /** A fresh request for the same customer mail, after the one sent here went out. */
  function startAnother() {
    setRfqId(crypto.randomUUID());
    setSendResult(null);
    // The files went with the request just sent; the next one starts without any.
    setAttachments([]);
    setSendMessage(null);
    lastSendBody.current = null;
    sendRfq.reset();
  }

  function send() {
    const parsed = parseRfqDetailsForm(values);
    const allVendors = vendors.data?.vendors ?? [];
    const recipients = toRfqRecipients(allVendors, selectedContactIds);
    const recipientsProblem = recipientsError(recipients);
    const texts = mailTextsForSend(categoriesOfRecipients(allVendors, recipients), drafts);
    setErrors(parsed.ok ? {} : parsed.errors);
    setRecipientsMessage(recipientsProblem);
    setSendMessage(texts.ok ? null : texts.message);
    if (!parsed.ok || recipientsProblem || !texts.ok) {
      const firstInvalid = parsed.ok
        ? 'recipients'
        : ((Object.keys(parsed.errors) as RfqDetailsField[])[0] ?? 'recipients');
      if (!parsed.ok || recipientsProblem) {
        requestAnimationFrame(() =>
          form.current?.querySelector<HTMLElement>(`#${fieldId(firstInvalid)}`)?.focus(),
        );
      }
      return;
    }
    const body: SendRfqBody = {
      sourceEmailId: email.id,
      details: parsed.details,
      recipients,
      mails: texts.mails,
    };
    // The API defaults attachmentIds to none; leave it out rather than send an empty list.
    if (attachments.length > 0) body.attachmentIds = attachments.map((attachment) => attachment.id);
    lastSendBody.current = body;
    sendRfq.mutate(body);
  }

  function retry() {
    if (lastSendBody.current) sendRfq.mutate(lastSendBody.current);
  }

  function submit() {
    const parsed = parseRfqDetailsForm(values);
    const recipients = toRfqRecipients(vendors.data?.vendors ?? [], selectedContactIds);
    const recipientsProblem = recipientsError(recipients);
    setErrors(parsed.ok ? {} : parsed.errors);
    setRecipientsMessage(recipientsProblem);
    if (!parsed.ok || recipientsProblem) {
      const firstInvalid = parsed.ok
        ? 'recipients'
        : ((Object.keys(parsed.errors) as RfqDetailsField[])[0] ?? 'recipients');
      requestAnimationFrame(() =>
        form.current?.querySelector<HTMLElement>(`#${fieldId(firstInvalid)}`)?.focus(),
      );
      return;
    }
    writeDrafts.mutate({
      details: parsed.details,
      vendorIds: recipients.map((recipient) => recipient.vendorId),
    });
  }

  const suggesting = open && !prefilled && suggestion.isFetching;
  const suggestionFailed =
    open && !prefilled && suggestion.isError && !isUnauthenticated(suggestion.error);
  const fieldId = (field: RfqDetailsField | 'recipients') => `rfq-${field}-${email.id}`;
  const busy = suggesting || writeDrafts.isPending || sendRfq.isPending;
  // Once the mails are out the form is a record of what was sent, not something to edit.
  const editable = !busy && sentThisSession === null;
  const selectedContactCount = selectedContactIds.size;
  // What is ticked now (for the pending text and the "no draft for this category yet" warning)...
  const selectedCategories = categoriesOfRecipients(
    vendors.data?.vendors ?? [],
    toRfqRecipients(vendors.data?.vendors ?? [], selectedContactIds),
  );
  // ...versus what the model actually returned, which is what the draft editors show.
  const draftedCategories = VENDOR_CATEGORIES.filter((category) => drafts?.[category]);
  const fieldError = (field: RfqDetailsField) =>
    errors[field] ? (
      <p id={`${fieldId(field)}-error`} className="formError" role="alert">
        {errors[field]}
      </p>
    ) : null;
  const describedBy = (field: RfqDetailsField) =>
    errors[field] ? `${fieldId(field)}-error` : undefined;

  return (
    <div className="rfqPanel">
      <div className="rfqPanelButtons">
        {recordOffered && existingRecord && (
          <button
            type="button"
            className="button secondary"
            aria-expanded={view === 'record'}
            onClick={() => (view === 'record' ? close() : setView('record'))}
          >
            {view === 'record' ? 'Hide vendor quotes' : rfqProgressLabel(existingRecord.mails)}
          </button>
        )}
        <button
          ref={trigger}
          type="button"
          className="button secondary"
          aria-expanded={view === 'form'}
          onClick={() => (view === 'form' ? close() : setView('form'))}
        >
          {view === 'form'
            ? sentThisSession
              ? 'Hide vendor quotes'
              : 'Hide vendor quote request'
            : sentThisSession
              ? rfqProgressLabel(sentThisSession.mails)
              : recordOffered
                ? 'Request vendor quotes again'
                : 'Request vendor quotes'}
        </button>
      </div>
      {open && existingRfq.isError && !isUnauthenticated(existingRfq.error) && (
        <p className="inlineAlert" role="alert">
          Could not check whether vendor quotes were already requested for this message.{' '}
          {errorMessage(existingRfq.error)}{' '}
          <button
            type="button"
            className="button textButton"
            onClick={() => void existingRfq.refetch()}
          >
            Try again
          </button>
        </p>
      )}
      {view === 'record' && existingRecord && (
        <RfqRecord
          result={existingRecord}
          vendors={vendors.data?.vendors ?? []}
          emailId={email.id}
          statusHeadingRef={statusHeading}
          polling={existingRfq.isFetching}
          onClose={close}
        />
      )}
      {view === 'form' && (
        <form
          ref={form}
          className="rfqForm"
          aria-label="Vendor quote request"
          aria-busy={busy}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) submit();
          }}
        >
          <p className="eyebrow">Shipment details</p>
          <p className="muted rfqSourceNote">
            Read from the message you opened:{' '}
            {email.sender.name || email.sender.email || 'unknown sender'},{' '}
            <time dateTime={email.receivedAt}>
              {new Date(email.receivedAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </time>
            . Open another message of the conversation to read that one instead.
          </p>
          {suggesting && (
            <p className="rfqSuggestionStatus" role="status">
              <RefreshCw size={16} aria-hidden="true" className="spinning" />
              Reading shipment details from the message…
            </p>
          )}
          {suggestionFailed && (
            <p className="inlineAlert" role="alert">
              {errorMessage(suggestion.error)}{' '}
              <button
                type="button"
                className="button textButton"
                onClick={() => void suggestion.refetch()}
              >
                Try the suggestion again
              </button>
            </p>
          )}
          <div className="rfqFieldGrid">
            <TextField
              field="originPort"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              required
              disabled={!editable}
            >
              {fieldError('originPort')}
            </TextField>
            <TextField
              field="destinationPort"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              required
              disabled={!editable}
            >
              {fieldError('destinationPort')}
            </TextField>
            <div className="rfqField">
              <label htmlFor={fieldId('mode')}>{rfqDetailsFieldLabels.mode}</label>
              <select
                id={fieldId('mode')}
                value={values.mode}
                disabled={!editable}
                onChange={(event) => update('mode', event.target.value as FreightMode | '')}
              >
                <option value="">Not stated</option>
                {FREIGHT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {freightModeTitles[mode]}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              field="incoterm"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              disabled={!editable}
              placeholder="FOB, CIF, EXW…"
            >
              {fieldError('incoterm')}
            </TextField>
            <TextField
              field="commodity"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              disabled={!editable}
            >
              {fieldError('commodity')}
            </TextField>
            <TextField
              field="readyDate"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              disabled={!editable}
              placeholder="As the customer put it, e.g. end of November"
            >
              {fieldError('readyDate')}
            </TextField>
            <TextField
              field="grossWeightKg"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              disabled={!editable}
              inputMode="decimal"
            >
              {fieldError('grossWeightKg')}
            </TextField>
            <TextField
              field="volumeCbm"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              disabled={!editable}
              inputMode="decimal"
            >
              {fieldError('volumeCbm')}
            </TextField>
            <TextField
              field="senderAddress"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              disabled={!editable}
              placeholder="When the rate must include pickup (EXW, FCA)"
            >
              {fieldError('senderAddress')}
            </TextField>
            <TextField
              field="receiverAddress"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              disabled={!editable}
              placeholder="When the rate must include delivery (DAP, DDP)"
            >
              {fieldError('receiverAddress')}
            </TextField>
          </div>
          <ContainerRows
            values={values}
            fieldId={fieldId}
            disabled={!editable}
            onChange={(containers) => update('containers', containers)}
          >
            {fieldError('containers')}
          </ContainerRows>
          <div className="rfqField rfqFieldWide">
            <label htmlFor={fieldId('specialInstructions')}>
              {rfqDetailsFieldLabels.specialInstructions}
            </label>
            <textarea
              id={fieldId('specialInstructions')}
              rows={3}
              value={values.specialInstructions}
              disabled={!editable}
              aria-describedby={describedBy('specialInstructions')}
              onChange={(event) => update('specialInstructions', event.target.value)}
            />
            {fieldError('specialInstructions')}
          </div>
          {vendors.isPending ? (
            <p className="rfqSuggestionStatus" role="status">
              <RefreshCw size={16} aria-hidden="true" className="spinning" />
              Loading vendors…
            </p>
          ) : vendors.isError && !isUnauthenticated(vendors.error) ? (
            <p className="inlineAlert" role="alert">
              Vendors could not be loaded. {errorMessage(vendors.error)}{' '}
              <button
                type="button"
                className="button textButton"
                onClick={() => void vendors.refetch()}
              >
                Try again
              </button>
            </p>
          ) : (
            <RfqRecipientsPicker
              vendors={vendors.data?.vendors ?? []}
              selectedContactIds={selectedContactIds}
              disabled={!editable}
              legendId={fieldId('recipients')}
              onChange={(next) => {
                setSelectedContactIds(next);
                setRecipientsMessage(null);
              }}
            >
              {recipientsMessage && (
                <p className="formError" role="alert">
                  {recipientsMessage}
                </p>
              )}
            </RfqRecipientsPicker>
          )}
          <div className="rfqActions">
            {sentThisSession === null && (
              <button type="submit" className="button primary" disabled={busy}>
                {writeDrafts.isPending
                  ? 'Drafting vendor mails…'
                  : drafts
                    ? 'Redraft vendor mails'
                    : 'Write vendor mails'}
              </button>
            )}
            <button
              type="button"
              className="button textButton"
              onClick={close}
              disabled={writeDrafts.isPending || sendRfq.isPending}
            >
              {sentThisSession === null ? 'Cancel' : 'Close'}
            </button>
            {writeDrafts.isPending && (
              <span role="status">
                One mail per category:{' '}
                {selectedCategories.map((category) => vendorCategoryTitles[category]).join(', ')}.
              </span>
            )}
          </div>
          {writeDrafts.isError && !isUnauthenticated(writeDrafts.error) && (
            <p className="inlineAlert" role="alert">
              {errorMessage(writeDrafts.error)}
            </p>
          )}
          {drafts && (
            <section className="rfqDrafts" aria-labelledby={`rfq-drafts-${email.id}`}>
              <h2 id={`rfq-drafts-${email.id}`} ref={draftsHeading} tabIndex={-1}>
                Vendor mails
              </h2>
              <p className="muted">
                {sentThisSession === null
                  ? 'One mail per vendor category; every ticked contact of that category receives your edited text. Nothing has been sent yet.'
                  : 'Sent from your mailbox as shown here, one Gmail thread per contact.'}
              </p>
              {draftedCategories.map((category) => {
                const draft = drafts[category];
                if (!draft) return null;
                return (
                  <div key={category} className="rfqDraft">
                    <h3>{vendorCategoryTitles[category]}</h3>
                    <div className="rfqField">
                      <label htmlFor={`rfq-draft-subject-${category}-${email.id}`}>Subject</label>
                      <input
                        id={`rfq-draft-subject-${category}-${email.id}`}
                        type="text"
                        maxLength={MAX_RFQ_MAIL_SUBJECT_LENGTH}
                        value={draft.subject}
                        disabled={!editable}
                        onChange={(event) => updateDraft(category, { subject: event.target.value })}
                      />
                    </div>
                    <div className="rfqField">
                      <label htmlFor={`rfq-draft-body-${category}-${email.id}`}>Message</label>
                      <textarea
                        id={`rfq-draft-body-${category}-${email.id}`}
                        rows={12}
                        maxLength={MAX_RFQ_MAIL_BODY_LENGTH}
                        value={draft.bodyText}
                        disabled={!editable}
                        onChange={(event) =>
                          updateDraft(category, { bodyText: event.target.value })
                        }
                      />
                    </div>
                  </div>
                );
              })}
              {(sentThisSession === null || attachments.length > 0) && (
                <OutboundAttachmentsField
                  session={session}
                  attachments={attachments}
                  onAttachmentsChange={setAttachments}
                  disabled={!editable}
                />
              )}
              {sentThisSession === null &&
                selectedCategories.some((category) => !drafts[category]) && (
                  <p className="inlineAlert" role="alert">
                    You ticked a vendor of a category that has no draft yet. Redraft the vendor
                    mails.
                  </p>
                )}
              {sentThisSession === null && (
                <div className="rfqActions">
                  <button type="button" className="button primary" disabled={busy} onClick={send}>
                    {sendRfq.isPending
                      ? 'Sending…'
                      : selectedContactCount === 1
                        ? 'Send to 1 contact'
                        : `Send to ${selectedContactCount} contacts`}
                  </button>
                  {sendRfq.isPending && (
                    <span role="status">One mail per contact, two at a time.</span>
                  )}
                </div>
              )}
              {sendMessage && (
                <p className="formError" role="alert">
                  {sendMessage}
                </p>
              )}
              {sendRfq.isError && !isUnauthenticated(sendRfq.error) && (
                <p className="inlineAlert" role="alert">
                  {errorMessage(sendRfq.error)}
                </p>
              )}
              {sentThisSession && (
                <>
                  <RfqSendStatus
                    mails={sentThisSession.mails}
                    vendors={vendors.data?.vendors ?? []}
                    headingId={`rfq-send-status-${email.id}`}
                    headingRef={statusHeading}
                    polling={rfqStatus.isFetching || rfqStatus.isRefetching}
                    retrying={sendRfq.isPending}
                    onRetry={retry}
                  />
                  {rfqStatus.isError && !isUnauthenticated(rfqStatus.error) && (
                    <p className="inlineAlert" role="alert">
                      The latest status could not be read. {errorMessage(rfqStatus.error)}
                    </p>
                  )}
                  {!anyMailSending(sentThisSession.mails) && (
                    <div className="rfqActions">
                      <button type="button" className="button textButton" onClick={startAnother}>
                        Start another request for this message
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </form>
      )}
    </div>
  );
}

type TextFieldName = Exclude<RfqDetailsField, 'mode' | 'containers' | 'specialInstructions'>;

function TextField({
  field,
  values,
  fieldId,
  describedBy,
  onChange,
  required,
  disabled,
  placeholder,
  inputMode,
  children,
}: {
  field: TextFieldName;
  values: RfqDetailsFormValues;
  fieldId: (field: RfqDetailsField) => string;
  describedBy: (field: RfqDetailsField) => string | undefined;
  onChange: (field: TextFieldName, value: string) => void;
  required?: boolean;
  disabled: boolean;
  placeholder?: string;
  inputMode?: 'decimal';
  children: ReactNode;
}) {
  return (
    <div className="rfqField">
      <label htmlFor={fieldId(field)}>
        {rfqDetailsFieldLabels[field]}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={fieldId(field)}
        type="text"
        value={values[field]}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        inputMode={inputMode}
        aria-invalid={describedBy(field) ? true : undefined}
        aria-describedby={describedBy(field)}
        onChange={(event) => onChange(field, event.target.value)}
      />
      {children}
    </div>
  );
}

/** Ticks for the common boxes add a row of one; any type can still be typed, "45ft reefer" included. */
function ContainerRows({
  values,
  fieldId,
  disabled,
  onChange,
  children,
}: {
  values: RfqDetailsFormValues;
  fieldId: (field: RfqDetailsField) => string;
  disabled: boolean;
  onChange: (containers: RfqDetailsFormValues['containers']) => void;
  children: ReactNode;
}) {
  const rows = values.containers;
  const presentTypes = new Set(rows.map((row) => row.type.trim().toLowerCase()));
  return (
    <fieldset className="rfqContainers" disabled={disabled}>
      <legend id={fieldId('containers')} tabIndex={-1}>
        {rfqDetailsFieldLabels.containers}
      </legend>
      <div className="rfqContainerQuickAdd">
        {SUGGESTED_CONTAINER_TYPES.filter((type) => !presentTypes.has(type.toLowerCase())).map(
          (type) => (
            <button
              key={type}
              type="button"
              className="button textButton"
              onClick={() => onChange([...rows, { type, quantity: '1' }])}
            >
              + {type}
            </button>
          ),
        )}
        <button
          type="button"
          className="button textButton"
          onClick={() => onChange([...rows, { type: '', quantity: '1' }])}
        >
          + Other type
        </button>
      </div>
      {rows.length > 0 && (
        <ul className="rfqContainerRows">
          {rows.map((row, index) => (
            <li key={index}>
              <label>
                <span>Type</span>
                <input
                  type="text"
                  value={row.type}
                  onChange={(event) =>
                    onChange(
                      rows.map((other, otherIndex) =>
                        otherIndex === index ? { ...other, type: event.target.value } : other,
                      ),
                    )
                  }
                />
              </label>
              <label>
                <span>Quantity</span>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={row.quantity}
                  onChange={(event) =>
                    onChange(
                      rows.map((other, otherIndex) =>
                        otherIndex === index ? { ...other, quantity: event.target.value } : other,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="button textButton"
                aria-label={`Remove container ${index + 1}`}
                onClick={() => onChange(rows.filter((_, otherIndex) => otherIndex !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {children}
    </fieldset>
  );
}
