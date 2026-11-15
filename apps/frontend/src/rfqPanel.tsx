import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { SUGGESTED_CONTAINER_TYPES } from '@lc/contract';
import type { EmailDetailResponse, FreightMode, RfqDetails, SessionResponse } from '@lc/contract';
import { errorMessage, frontendApi, isUnauthenticated } from './frontendApi.js';
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

/**
 * "Request vendor quotes" on the opened inbox mail, whatever its classification (a misclassified
 * request must still be quotable): opens the RFQ details form prefilled by the model's reading of
 * that message, for the operator to correct. Saving the details is the first step; vendor
 * selection, drafting and sending follow on the same panel in later changes.
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
  const [savedDetails, setSavedDetails] = useState<RfqDetails | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);

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
  useEffect(() => {
    if (isUnauthenticated(suggestion.error)) onSignedOut();
  }, [suggestion.error, onSignedOut]);

  if (email.gmailLabel !== 'inbox') return null;

  function update<Field extends RfqDetailsField>(field: Field, value: RfqDetailsFormValues[Field]) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
    setSavedDetails(null);
  }

  function close() {
    setOpen(false);
    setErrors({});
    requestAnimationFrame(() => trigger.current?.focus());
  }

  const suggesting = open && !prefilled && suggestion.isFetching;
  const suggestionFailed =
    open && !prefilled && suggestion.isError && !isUnauthenticated(suggestion.error);
  const fieldId = (field: RfqDetailsField) => `rfq-${field}-${email.id}`;
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
          aria-busy={suggesting}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const result = parseRfqDetailsForm(values);
            if (result.ok) {
              setErrors({});
              setSavedDetails(result.details);
              return;
            }
            setErrors(result.errors);
            setSavedDetails(null);
            const firstInvalid = (Object.keys(result.errors) as RfqDetailsField[])[0];
            if (firstInvalid) {
              requestAnimationFrame(() =>
                form.current?.querySelector<HTMLElement>(`#${fieldId(firstInvalid)}`)?.focus(),
              );
            }
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
              disabled={suggesting}
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
              disabled={suggesting}
            >
              {fieldError('destinationPort')}
            </TextField>
            <div className="rfqField">
              <label htmlFor={fieldId('mode')}>{rfqDetailsFieldLabels.mode}</label>
              <select
                id={fieldId('mode')}
                value={values.mode}
                disabled={suggesting}
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
              disabled={suggesting}
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
              disabled={suggesting}
            >
              {fieldError('commodity')}
            </TextField>
            <TextField
              field="readyDate"
              values={values}
              fieldId={fieldId}
              describedBy={describedBy}
              onChange={update}
              disabled={suggesting}
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
              disabled={suggesting}
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
              disabled={suggesting}
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
              disabled={suggesting}
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
              disabled={suggesting}
              placeholder="When the rate must include delivery (DAP, DDP)"
            >
              {fieldError('receiverAddress')}
            </TextField>
          </div>
          <ContainerRows
            values={values}
            fieldId={fieldId}
            disabled={suggesting}
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
              disabled={suggesting}
              aria-describedby={describedBy('specialInstructions')}
              onChange={(event) => update('specialInstructions', event.target.value)}
            />
            {fieldError('specialInstructions')}
          </div>
          <div className="rfqActions">
            <button type="submit" className="button primary" disabled={suggesting}>
              Save details
            </button>
            <button type="button" className="button textButton" onClick={close}>
              Cancel
            </button>
            {savedDetails && (
              <span role="status">
                Details saved: {savedDetails.originPort} → {savedDetails.destinationPort}
                {savedDetails.containers.length > 0
                  ? `, ${savedDetails.containers
                      .map((container) => `${container.quantity} × ${container.type}`)
                      .join(', ')}`
                  : ''}
                . Choosing vendors comes next.
              </span>
            )}
          </div>
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
