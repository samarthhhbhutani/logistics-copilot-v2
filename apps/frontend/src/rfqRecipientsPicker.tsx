import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { VendorResponse } from '@lc/contract';
import {
  VENDOR_CATEGORIES,
  selectableVendorsByCategory,
  vendorCategoryTitles,
} from './rfqRecipients.js';

/**
 * Who the RFQ goes to: every active vendor of the desk, grouped by category, each person a tick.
 * The vendor's own box ticks or clears all its people and shows a dash when only some are ticked.
 */
export function RfqRecipientsPicker({
  vendors,
  selectedContactIds,
  onChange,
  disabled,
  legendId,
  children,
}: {
  vendors: VendorResponse[];
  selectedContactIds: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled: boolean;
  legendId: string;
  children: ReactNode;
}) {
  const byCategory = selectableVendorsByCategory(vendors);
  const nothingToPick = VENDOR_CATEGORIES.every((category) => byCategory[category].length === 0);

  function toggleContacts(contactIds: string[], ticked: boolean) {
    const next = new Set(selectedContactIds);
    for (const contactId of contactIds) {
      if (ticked) next.add(contactId);
      else next.delete(contactId);
    }
    onChange(next);
  }

  return (
    <fieldset className="rfqRecipients" disabled={disabled}>
      <legend id={legendId} tabIndex={-1}>
        Vendors
      </legend>
      {nothingToPick ? (
        <p className="muted">No active vendors with contacts yet.</p>
      ) : (
        VENDOR_CATEGORIES.filter((category) => byCategory[category].length > 0).map((category) => (
          <div key={category} className="rfqVendorCategory">
            <h3>{vendorCategoryTitles[category]}</h3>
            <ul>
              {byCategory[category].map((vendor) => {
                const contactIds = vendor.contacts.map((contact) => contact.id);
                const tickedCount = contactIds.filter((id) => selectedContactIds.has(id)).length;
                return (
                  <li key={vendor.id} className="rfqVendor">
                    <label className="rfqVendorName">
                      <IndeterminateCheckbox
                        checked={tickedCount === contactIds.length}
                        indeterminate={tickedCount > 0 && tickedCount < contactIds.length}
                        onChange={(ticked) => toggleContacts(contactIds, ticked)}
                      />
                      <strong>{vendor.vendorName}</strong>
                      <span className="muted">
                        {tickedCount} of {contactIds.length}
                      </span>
                    </label>
                    <ul className="rfqContacts">
                      {vendor.contacts.map((contact) => (
                        <li key={contact.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={selectedContactIds.has(contact.id)}
                              onChange={(event) =>
                                toggleContacts([contact.id], event.target.checked)
                              }
                            />
                            <span>{contact.contactName}</span>
                            <span className="muted">{contact.emailAddress}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
      {children}
    </fieldset>
  );
}

/** `indeterminate` is a DOM property, not an attribute, so it is set through a ref. */
function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: (ticked: boolean) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={box}
      type="checkbox"
      checked={checked}
      aria-checked={indeterminate ? 'mixed' : checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
