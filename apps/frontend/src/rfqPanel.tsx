import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
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
  RfqDetails,
  SessionResponse,
  VendorCategory,
} from '@lc/contract';
import { errorMessage, frontendApi, isUnauthenticated } from './frontendApi.js';
import {
  VENDOR_CATEGORIES,
  categoriesOfRecipients,
  recipientsError,
  toRfqRecipients,
  vendorCategoryTitles,
} from './rfqRecipients.js';
import { RfqRecipientsPicker } from './rfqRecipientsPicker.js';
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

/** The operator's editable text for one category, started from the model's draft. */
interface RfqMailDraftValues {
  subject: string;
  bodyText: string;
}
type RfqMailDrafts = Partial<Record<VendorCategory, RfqMailDraftValues>>;

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
 * that message, for the operator to correct, with the desk's vendors to tick underneath. "Write
 * vendor mails" drafts one mail per vendor category for the operator to edit on the same screen.
 * Nothing is stored or sent here; sending follows in a later change.
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
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<RfqDetailsFormValues>(EMPTY_RFQ_DETAILS_FORM);
  const [prefilled, setPrefilled] = useState(false);
  const [errors, setErrors] = useState<RfqDetailsFormErrors>({});
  const [selectedContactIds, setSelectedContactIds] = useState<ReadonlySet<string>>(new Set());
  const [recipientsMessage, setRecipientsMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<RfqMailDrafts | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const draftsHeading = useRef<HTMLHeadingElement>(null);

  const suggestion = useQuery({
    queryKey: ['rfqSuggestion', session.tenantId, session.mailboxId, email.id],
    queryFn: ({ signal }) => frontendApi.rfqSuggestion(session, email.id, signal),
    enabled: open && !prefilled,
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
  useEffect(() => {
    if (
      isUnauthenticated(suggestion.error) ||
      isUnauthenticated(vendors.error) ||
      isUnauthenticated(writeDrafts.error)
    ) {
      onSignedOut();
    }
  }, [suggestion.error, vendors.error, writeDrafts.error, onSignedOut]);

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
    if (writeDrafts.isPending) return;
    setOpen(false);
    setErrors({});
    setRecipientsMessage(null);
    requestAnimationFrame(() => trigger.current?.focus());
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
  const busy = suggesting || writeDrafts.isPending;
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
      <button
        ref={trigger}
        type="button"
        className="button secondary"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {open ? 'Hide vendor quote request' : 'Request vendor quotes'}
      </button>
      {open && (
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
              disabled={busy}
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
              disabled={busy}
            >
              {fieldError('destinationPort')}
            </TextField>
            <div className="rfqField">
              <label htmlFor={fieldId('mode')}>{rfqDetailsFieldLabels.mode}</label>
              <select
                id={fieldId('mode')}
                value={values.mode}
                disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
            >
              {fieldError('commodity')}
            </TextField>
            <TextField
              field="readyDate"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
              placeholder="When the rate must include delivery (DAP, DDP)"
            >
              {fieldError('receiverAddress')}
            </TextField>
          </div>
          <ContainerRows
            values={values}
            fieldId={fieldId}
            disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
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
            <button type="submit" className="button primary" disabled={busy}>
              {writeDrafts.isPending
                ? 'Drafting vendor mails…'
                : drafts
                  ? 'Redraft vendor mails'
                  : 'Write vendor mails'}
            </button>
            <button
              type="button"
              className="button textButton"
              onClick={close}
              disabled={writeDrafts.isPending}
            >
              Cancel
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
                One mail per vendor category; every ticked contact of that category receives your
                edited text. Nothing has been sent yet.
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
                        disabled={busy}
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
                        disabled={busy}
                        onChange={(event) =>
                          updateDraft(category, { bodyText: event.target.value })
                        }
                      />
                    </div>
                  </div>
                );
              })}
              {selectedCategories.some((category) => !drafts[category]) && (
                <p className="inlineAlert" role="alert">
                  You ticked a vendor of a category that has no draft yet. Redraft the vendor mails.
                </p>
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
