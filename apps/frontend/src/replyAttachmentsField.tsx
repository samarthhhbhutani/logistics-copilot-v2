import { useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Paperclip, X } from 'lucide-react';
import type { ReplyAttachmentResponse, SessionResponse } from '@lc/contract';
import { REPLY_ATTACHMENTS_MAX_PER_REPLY, REPLY_ATTACHMENTS_MAX_TOTAL_BYTES } from '@lc/contract';
import { errorMessage, frontendApi, FrontendApiError } from './frontendApi.js';

/** "812 bytes", "40.5 KB", "9.8 MB": enough precision to see which file fills the reply. */
export function formatFileSize(sizeBytes: number): string {
  const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  if (sizeBytes < 1024) return `${sizeBytes} bytes`;
  if (sizeBytes < 1024 * 1024) return `${oneDecimal.format(sizeBytes / 1024)} KB`;
  return `${oneDecimal.format(sizeBytes / (1024 * 1024))} MB`;
}

/**
 * The files a reply carries. Each pick is uploaded at once (one request per file, in the order
 * picked) so the send only names ids; a file that the server or the per-reply caps refuse stops the
 * batch there, with the files before it kept and the reason shown under the list. Removing a chip
 * deletes the upload. The composer owns the list: it sends the ids and clears them for the next reply.
 */
export function ReplyAttachmentsField({
  session,
  attachments,
  onAttachmentsChange,
  disabled,
}: {
  session: SessionResponse;
  attachments: ReplyAttachmentResponse[];
  onAttachmentsChange: (attachments: ReplyAttachmentResponse[]) => void;
  /** The reply is sending or sent: the list is frozen with it. */
  disabled: boolean;
}) {
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: async (files: File[]) => {
      let attached = attachments;
      for (const file of files) {
        try {
          if (attached.length >= REPLY_ATTACHMENTS_MAX_PER_REPLY) {
            throw new FrontendApiError(413, 'attachment_limit_reached');
          }
          const totalBytes = attached.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
          if (totalBytes + file.size > REPLY_ATTACHMENTS_MAX_TOTAL_BYTES) {
            throw new FrontendApiError(413, 'attachments_too_large');
          }
          const attachment = await frontendApi.uploadReplyAttachment(session, file);
          attached = [...attached, attachment];
          onAttachmentsChange(attached);
        } catch (error) {
          setProblem(`${file.name}: ${errorMessage(error)}`);
          return;
        }
      }
    },
  });
  const remove = useMutation({
    mutationFn: async (attachment: ReplyAttachmentResponse) => {
      try {
        await frontendApi.deleteReplyAttachment(session, attachment.id);
      } catch (error) {
        // Already gone (or already sent): either way it has no place in this list.
        if (!(error instanceof FrontendApiError && error.status === 404)) throw error;
      }
    },
    onSuccess: (_, attachment) => {
      onAttachmentsChange(attachments.filter((candidate) => candidate.id !== attachment.id));
    },
    onError: (error, attachment) => setProblem(`${attachment.fileName}: ${errorMessage(error)}`),
  });
  const busy = disabled || attach.isPending || remove.isPending;

  return (
    <div className="replyField">
      <span className="replyFieldLabel">Attachments</span>
      {attachments.length > 0 && (
        <ul className="attachedFiles" aria-label="Attached files">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="attachedFile">
              <Paperclip size={14} aria-hidden="true" />
              <span className="attachedFileName">{attachment.fileName}</span>
              <span className="muted">{formatFileSize(attachment.sizeBytes)}</span>
              <button
                type="button"
                className="attachedFileRemove"
                aria-label={`Remove ${attachment.fileName}`}
                disabled={busy}
                onClick={() => {
                  setProblem(null);
                  remove.mutate(attachment);
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="replyComposerActions">
        <button
          type="button"
          className="button secondary"
          aria-describedby={hintId}
          disabled={busy || attachments.length >= REPLY_ATTACHMENTS_MAX_PER_REPLY}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={16} aria-hidden="true" />
          {attach.isPending ? 'Attaching…' : 'Attach files'}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="reply-attachment-files"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            if (files.length === 0) return;
            setProblem(null);
            attach.mutate(files);
          }}
        />
      </div>
      <p id={hintId} className="muted fieldHint">
        Up to {REPLY_ATTACHMENTS_MAX_PER_REPLY} files,{' '}
        {REPLY_ATTACHMENTS_MAX_TOTAL_BYTES / (1024 * 1024)} MB in total.
      </p>
      {problem && (
        <p className="formError" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
