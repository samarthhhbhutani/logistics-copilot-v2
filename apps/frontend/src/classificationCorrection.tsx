import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ClassificationLabel,
  CurrentClassificationResponse,
  EmailDetailResponse,
  ListEmailsResponse,
  SessionResponse,
  ThreadResponse,
} from '@lc/contract';
import { classificationLabelTitles } from './classificationBadge.js';
import {
  ClassificationOutcomeUnknownError,
  errorMessage,
  frontendApi,
  FrontendApiError,
  isUnauthenticated,
} from './frontendApi.js';

const classificationLabels: ClassificationLabel[] = [
  'customer_request',
  'customer_reply',
  'rate_card',
  'general',
];

export function ClassificationCorrection({
  email,
  session,
  onSignedOut,
  onRefresh,
}: {
  email: EmailDetailResponse;
  session: SessionResponse;
  onSignedOut: () => void;
  onRefresh: () => Promise<boolean>;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState<ClassificationLabel>(email.classification?.label ?? 'general');
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const pendingStatus = useRef<HTMLSpanElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const submissionInFlight = useRef(false);

  useEffect(
    () => () => {
      if (submissionInFlight.current) {
        // The POST may have reached the server before navigation aborted its response. Force the
        // next conversation and inbox read rather than showing a stale label from their caches.
        const scope = [session.tenantId, session.mailboxId];
        void queryClient.invalidateQueries({
          queryKey: ['thread', ...scope],
          refetchType: 'inactive',
        });
        void queryClient.invalidateQueries({
          queryKey: ['emails', ...scope],
          refetchType: 'inactive',
        });
      }
      controller.current?.abort();
    },
    [queryClient, session.mailboxId, session.tenantId],
  );
  useEffect(() => {
    if (editing) select.current?.focus();
  }, [editing]);
  const save = useMutation({
    mutationFn: async (selectedLabel: ClassificationLabel) => {
      controller.current = new AbortController();
      return frontendApi.correctClassification(
        session,
        email.id,
        selectedLabel,
        controller.current.signal,
      );
    },
    onSuccess: async (classification: CurrentClassificationResponse, selectedLabel) => {
      // A read already in flight must not overwrite the new server row. Patch all cached pages
      // in this mailbox, including a thread opened through a different message, then revalidate.
      const scope = [session.tenantId, session.mailboxId];
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['thread', ...scope] }),
        queryClient.cancelQueries({ queryKey: ['emails', ...scope] }),
      ]);
      queryClient.setQueriesData<ThreadResponse>({ queryKey: ['thread', ...scope] }, (thread) =>
        thread?.emails.some((message) => message.id === email.id)
          ? {
              ...thread,
              emails: thread.emails.map((message) =>
                message.id === email.id ? { ...message, classification } : message,
              ),
            }
          : thread,
      );
      queryClient.setQueriesData<ListEmailsResponse>({ queryKey: ['emails', ...scope] }, (page) =>
        page?.emails.some((message) => message.id === email.id)
          ? {
              ...page,
              emails: page.emails.map((message) =>
                message.id === email.id ? { ...message, classification } : message,
              ),
            }
          : page,
      );
      void queryClient.invalidateQueries({
        queryKey: ['thread', ...scope],
        refetchType: 'inactive',
      });
      void queryClient.invalidateQueries({
        queryKey: ['emails', ...scope],
        refetchType: 'inactive',
      });
      setSavedMessage(
        email.classification?.label === selectedLabel
          ? 'Classification confirmed.'
          : 'Classification saved.',
      );
      setEditing(false);
      setOutcomeUnknown(false);
      requestAnimationFrame(() => trigger.current?.focus());
    },
    onError: (error) => {
      if (isUnauthenticated(error)) {
        onSignedOut();
      } else if (error instanceof ClassificationOutcomeUnknownError) {
        // The server might have appended the row even if the response was lost. Do not replay.
        // Invalidate now: navigation after onSettled no longer counts as an in-flight submission.
        const scope = [session.tenantId, session.mailboxId];
        void queryClient.invalidateQueries({
          queryKey: ['thread', ...scope],
          refetchType: 'inactive',
        });
        void queryClient.invalidateQueries({
          queryKey: ['emails', ...scope],
          refetchType: 'inactive',
        });
        setOutcomeUnknown(true);
      }
    },
    onSettled: () => {
      submissionInFlight.current = false;
      controller.current = null;
    },
    retry: false,
  });

  useEffect(() => {
    if (save.isPending) pendingStatus.current?.focus();
    else if (outcomeUnknown) refreshButton.current?.focus();
    else if (save.isError && !isUnauthenticated(save.error)) select.current?.focus();
  }, [save.isPending, save.isError, save.error, outcomeUnknown]);

  function closeEditor() {
    if (submissionInFlight.current) return;
    setEditing(false);
    setOutcomeUnknown(false);
    setRefreshError(false);
    save.reset();
    requestAnimationFrame(() => trigger.current?.focus());
  }

  if (email.gmailLabel !== 'inbox') return null;
  const isConfirmation = email.classification?.label === label;
  return (
    <div className="classificationCorrection">
      <button
        ref={trigger}
        type="button"
        className="button textButton"
        aria-expanded={editing}
        disabled={outcomeUnknown}
        onClick={() => {
          if (editing) {
            closeEditor();
          } else {
            setLabel(email.classification?.label ?? 'general');
            setSavedMessage(null);
            setRefreshError(false);
            save.reset();
            setEditing(true);
          }
        }}
      >
        Correct classification
      </button>
      {savedMessage && !editing && <span role="status">{savedMessage}</span>}
      {editing && (
        <form
          className="classificationCorrectionForm"
          aria-label="Correct classification"
          onSubmit={(event) => {
            event.preventDefault();
            if (submissionInFlight.current || outcomeUnknown) return;
            submissionInFlight.current = true;
            save.mutate(label);
          }}
        >
          <label htmlFor={`classification-${email.id}`}>Classification</label>
          <select
            ref={select}
            id={`classification-${email.id}`}
            value={label}
            onChange={(event) => setLabel(event.target.value as ClassificationLabel)}
            disabled={save.isPending || outcomeUnknown}
          >
            {classificationLabels.map((choice) => (
              <option key={choice} value={choice}>
                {classificationLabelTitles[choice]}
              </option>
            ))}
          </select>
          {save.isPending && (
            <span ref={pendingStatus} role="status" tabIndex={-1}>
              Saving classification…
            </span>
          )}
          <button
            type="submit"
            className="button secondary"
            disabled={save.isPending || outcomeUnknown}
          >
            {save.isPending
              ? 'Saving…'
              : isConfirmation
                ? 'Confirm classification'
                : 'Save classification'}
          </button>
          <button
            type="button"
            className="button textButton"
            onClick={closeEditor}
            disabled={save.isPending || outcomeUnknown}
          >
            Cancel
          </button>
          {save.isError && !isUnauthenticated(save.error) && (
            <p role="alert" className="formError">
              {outcomeUnknown
                ? 'We could not confirm whether the classification was saved. Refresh the conversation before trying again.'
                : save.error instanceof FrontendApiError && save.error.status === 409
                  ? 'This message is no longer available for classification.'
                  : errorMessage(save.error)}
            </p>
          )}
          {outcomeUnknown && (
            <button
              type="button"
              className="button secondary"
              ref={refreshButton}
              onClick={() => {
                void onRefresh().then((updated) => {
                  if (updated) closeEditor();
                  else setRefreshError(true);
                });
              }}
            >
              Refresh conversation
            </button>
          )}
          {refreshError && (
            <p className="formError" role="alert">
              Refresh failed. Try again.
            </p>
          )}
        </form>
      )}
    </div>
  );
}
