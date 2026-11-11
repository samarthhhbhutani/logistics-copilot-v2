import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EmailDetailResponse, SessionResponse } from '@lc/contract';
import { errorMessage, isUnauthenticated } from './frontendApi.js';
import { sanitizeEmailHtml } from './sanitizeEmailHtml.js';
import { createEmailDocument } from './emailFrameDocument.js';
import { EmailHtmlFrame } from './emailHtmlFrame.js';
import { loadInlineImages } from './loadInlineImages.js';

export function EmailBody({
  email,
  session,
  onSignedOut,
}: {
  email: EmailDetailResponse;
  session: SessionResponse;
  onSignedOut: () => void;
}) {
  return email.bodyHtml?.trim() ? (
    <HtmlEmailBody
      html={email.bodyHtml}
      emailId={email.id}
      session={session}
      onSignedOut={onSignedOut}
    />
  ) : email.bodyText.trim() ? (
    <div className="messageBody">{email.bodyText}</div>
  ) : (
    <p className="muted">This message has no text body.</p>
  );
}

function HtmlEmailBody({
  html,
  emailId,
  session,
  onSignedOut,
}: {
  html: string;
  emailId: string;
  session: SessionResponse;
  onSignedOut: () => void;
}) {
  const prepared = useMemo(() => sanitizeEmailHtml(html), [html]);
  const [imageAttempt, setImageAttempt] = useState(0);
  const [failedDocument, setFailedDocument] = useState<string | null>(null);
  const images = useQuery({
    queryKey: ['inlineImages', session.tenantId, session.mailboxId, emailId, prepared.contentIds],
    queryFn: ({ signal }) => loadInlineImages(session, emailId, prepared.contentIds, signal),
    enabled: prepared.contentIds.length > 0,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });
  const expired = isUnauthenticated(images.error);
  useEffect(() => {
    if (expired) onSignedOut();
  }, [expired, onSignedOut]);
  const sanitized = useMemo(
    () =>
      sanitizeEmailHtml(
        html,
        !images.isError && !images.isFetching ? images.data?.urls : undefined,
      ),
    [html, images.data, images.isError, images.isFetching],
  );
  const document = useMemo(() => createEmailDocument(sanitized), [sanitized]);
  const onImageFailure = useCallback(() => setFailedDocument(document), [document]);
  const imageLoadFailed =
    !images.isFetching &&
    (images.isError || (images.data?.failedImageCount ?? 0) > 0 || failedDocument === document);
  if (expired) return null;
  return (
    <div className="htmlEmailBody">
      <EmailHtmlFrame
        key={`${imageAttempt}:${document}`}
        document={document}
        onImageFailure={onImageFailure}
      />
      {images.isFetching && (
        <p className="inlineImageStatus muted" role="status">
          Loading images…
        </p>
      )}
      {imageLoadFailed && (
        <div className="inlineImageStatus">
          <p className="formError" role="alert">
            Some images could not be loaded.{images.isError ? ` ${errorMessage(images.error)}` : ''}
          </p>
          <button
            className="button textButton"
            onClick={() => {
              setFailedDocument(null);
              setImageAttempt((attempt) => attempt + 1);
              if (prepared.contentIds.length > 0) void images.refetch();
            }}
          >
            Retry images
          </button>
        </div>
      )}
    </div>
  );
}
