import { useEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import type { AttachmentSummaryResponse, SessionResponse } from '@lc/contract';
import { errorMessage, FrontendApiError, frontendApi, isUnauthenticated } from './frontendApi.js';
import { downloadPresignedFile } from './downloadPresignedFile.js';

export function MessageAttachments({
  session,
  emailId,
  onSignedOut,
}: {
  session: SessionResponse;
  emailId: string;
  onSignedOut: () => void;
}) {
  const attachments = useQuery({
    queryKey: ['attachments', session.tenantId, session.mailboxId, emailId],
    queryFn: ({ signal }) => frontendApi.attachments(session, emailId, signal),
  });
  const expired = isUnauthenticated(attachments.error);
  useEffect(() => {
    if (expired) onSignedOut();
  }, [expired, onSignedOut]);
  if (expired) return null;
  if (attachments.isPending)
    return (
      <p role="status" className="muted">
        Loading files…
      </p>
    );
  // Hide stale files on errors: an expired account must never leave an actionable download behind.
  if (attachments.isError)
    return (
      <div>
        <p role="alert" className="formError">
          Files could not be loaded. {errorMessage(attachments.error)}
        </p>
        <button className="button secondary" onClick={() => void attachments.refetch()}>
          Retry files
        </button>
      </div>
    );
  const files = attachments.data.attachments.filter((attachment) => !attachment.isInline);
  return (
    <>
      {files.length ? (
        <ul className="attachmentList">
          {files.map((attachment) => (
            <AttachmentFile
              key={attachment.id}
              attachment={attachment}
              emailId={emailId}
              session={session}
              onSignedOut={onSignedOut}
            />
          ))}
        </ul>
      ) : (
        <p className="muted">No attached files.</p>
      )}
      {attachments.data.attachments.some((attachment) => attachment.isInline) && (
        <p className="attachmentNote">Stored inline images appear in the message when supported.</p>
      )}
    </>
  );
}

function AttachmentFile({
  attachment,
  emailId,
  session,
  onSignedOut,
}: {
  attachment: AttachmentSummaryResponse;
  emailId: string;
  session: SessionResponse;
  onSignedOut: () => void;
}) {
  const controller = useRef<AbortController | null>(null);
  const downloadUrl = useRef<string | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const releaseDownload = () => {
    clearTimeout(releaseTimer.current);
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = null;
  };
  useEffect(
    () => () => {
      controller.current?.abort();
      clearTimeout(releaseTimer.current);
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    },
    [],
  );
  const download = useMutation({
    mutationFn: async (signal: AbortSignal) => {
      const { url } = await frontendApi.attachmentDownload(session, emailId, attachment.id, signal);
      const file = await downloadPresignedFile(url, attachment.sizeBytes, signal);
      const currentSession = await frontendApi.session(signal);
      if (
        currentSession?.tenantId !== session.tenantId ||
        currentSession?.mailboxId !== session.mailboxId
      )
        throw new FrontendApiError(401, 'session_changed');
      signal.throwIfAborted();
      // Save only after the entire transfer and final mailbox identity check.
      // Return no Blob to the mutation cache: bytes leave memory after this call.
      releaseDownload();
      downloadUrl.current = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = downloadUrl.current;
      link.download = attachment.fileName;
      link.referrerPolicy = 'no-referrer';
      link.click();
      // Allow the browser to consume the object URL, then release it even if the view stays open.
      releaseTimer.current = setTimeout(releaseDownload, 60_000);
    },
    onError: (error) => {
      if (isUnauthenticated(error)) onSignedOut();
    },
    // Do not cache signed URLs beyond this component's lifetime.
    gcTime: 0,
  });
  return (
    <li className="attachmentFile">
      <FileText size={18} aria-hidden="true" />
      <span className="attachmentIdentity">
        <strong>{attachment.fileName}</strong>
        <span>
          {attachment.sizeBytes < 1024
            ? `${attachment.sizeBytes} bytes`
            : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(attachment.sizeBytes / 1024)} KB`}{' '}
          · {attachment.contentType}
        </span>
      </span>
      <button
        className="button secondary"
        aria-label={`Download ${attachment.fileName}`}
        aria-disabled={download.isPending}
        onClick={() => {
          if (!download.isPending) {
            controller.current = new AbortController();
            download.mutate(controller.current.signal);
          }
        }}
      >
        <Download size={16} aria-hidden="true" />
        {download.isPending ? 'Preparing…' : 'Download'}
      </button>
      {download.isError && (
        <p role="alert" className="formError">
          {errorMessage(download.error)}
        </p>
      )}
    </li>
  );
}
