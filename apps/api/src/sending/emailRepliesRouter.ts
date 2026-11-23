import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import {
  GmailApiError,
  buildOutboundMessageId,
  buildReplyMessage,
  isDefinitiveGmailRejection,
  replySubject,
} from '@lc/core';
import type {
  EmailReadRepository,
  EncryptionUtil,
  GmailSender,
  MailboxConnectionRepository,
  OutboundAttachment,
  ReplyAttachmentRepository,
  SentMailRepository,
  SignatureImageRepository,
  TenantRepository,
} from '@lc/core';
import { sendReplyRequestSchema } from '@lc/contract';
import type { SendReplyFailedResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';
import { parseRequestBody } from '../http/parseRequestBody.js';
import { loadSendingMailbox } from './loadSendingMailbox.js';
import { findPickedReplyAttachments, readOutboundAttachments } from './pickedReplyAttachments.js';
import type { ReplyAttachmentStore } from './replyAttachmentStore.js';
import type { SignatureImageStore } from '../signature/signatureImageStore.js';
import { toSentMailResponse } from './sentMailResponses.js';

export interface EmailRepliesRouterDependencies {
  emailReadRepository: EmailReadRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  tenantRepository: TenantRepository;
  sentMailRepository: SentMailRepository;
  gmailSender: GmailSender;
  encryptionUtil: EncryptionUtil;
  signatureImageRepository: SignatureImageRepository;
  /** Undefined without a bucket: HTML signatures then go out without their images. */
  signatureImageStore: SignatureImageStore | undefined;
  replyAttachmentRepository: ReplyAttachmentRepository;
  /** Undefined without a bucket: a reply naming attachments then answers 503. */
  replyAttachmentStore: ReplyAttachmentStore | undefined;
  requireSession: RequestHandler;
}

/**
 * Replying to an inbound mail from the signed-in mailbox, mounted at /v1/mailbox/emails.
 *   POST /:emailId/replies  { sentMailId, text, cc?, attachmentIds? }
 *     201 SentMailResponse (sent)            404 mail outside the session's mailbox and tenant
 *     200 SentMailResponse (same sentMailId  409 not_inbound | no_sender | mailbox_not_connected |
 *         seen before: idempotent replay,        google_client_not_configured | sent_mail_id_taken
 *         body differences ignored)
 *     502 { error: send_failed, sentMail }   sentMail.status is `failed` when Gmail rejected it (4xx) or
 *                                            `sending` when the outcome is unknown (timeout, 5xx)
 *     409 attachment_not_found | attachment_already_sent, 413 attachments_too_large,
 *     503 reply_attachments_unavailable: see sendReplyRequestSchema
 *
 * Attachments are uploads the composer made earlier. They are stamped with the row only after Gmail
 * accepted the mail, so a refused send leaves them unsent and the retry under a new id carries the
 * same files. The one cost: a crash between Gmail's answer and the stamp leaves a `sent` row that
 * lists no files (Gmail's SENT copy still has them). A replayed row reports the files stamped on it;
 * the body's ids are ignored then.
 * Write-ahead: the sent_mails row is written before messages.send and moved pending -> sending ->
 * sent | failed, so a timeout or crash can never lose a mail Gmail may have accepted. The reply
 * carries In-Reply-To, References and Gmail's threadId so it lands in the original thread, and
 * our own Message-ID `<sentMailId@mailbox-domain>` so the SENT copy can be recognised.
 */
export function createEmailRepliesRouter({
  emailReadRepository,
  mailboxConnectionRepository,
  tenantRepository,
  sentMailRepository,
  gmailSender,
  encryptionUtil,
  signatureImageRepository,
  signatureImageStore,
  replyAttachmentRepository,
  replyAttachmentStore,
  requireSession,
}: EmailRepliesRouterDependencies): Router {
  const router = express.Router();

  router.post('/:emailId/replies', requireSession, async (request, response) => {
    const scope = getSession(response);
    const answeredEmailId = parseIdOr404(request.params.emailId);
    const replyRequest = parseRequestBody(sendReplyRequestSchema, request.body);

    const answeredEmail = await emailReadRepository.findEmail(scope, answeredEmailId);
    if (!answeredEmail) throw createHttpError(404, 'not_found');
    if (answeredEmail.gmailLabel !== 'inbox') throw createHttpError(409, 'not_inbound');
    if (!answeredEmail.senderEmail) throw createHttpError(409, 'no_sender');
    if (replyRequest.attachmentIds.length > 0 && !replyAttachmentStore) {
      response.status(503).json({ error: 'reply_attachments_unavailable' });
      return;
    }
    const attachments = await findPickedReplyAttachments(
      replyAttachmentRepository,
      scope,
      replyRequest.attachmentIds,
      replyRequest.sentMailId,
    );
    const { connection, credentials, refreshToken, inlineImages } = await loadSendingMailbox(
      {
        mailboxConnectionRepository,
        tenantRepository,
        encryptionUtil,
        signatureImageRepository,
        signatureImageStore,
      },
      scope,
    );

    const threadEmails = await emailReadRepository.listThreadEmails(
      scope,
      answeredEmail.gmailThreadId,
    );
    const rfcMessageId = buildOutboundMessageId(replyRequest.sentMailId, connection.emailAddress);
    const createResult = await sentMailRepository.createPending(scope, {
      id: replyRequest.sentMailId,
      kind: 'reply',
      inReplyToEmailId: answeredEmail.id,
      rfqId: null,
      vendorId: null,
      vendorContactId: null,
      gmailThreadId: answeredEmail.gmailThreadId,
      rfcMessageId,
      toRecipients: [{ name: answeredEmail.senderName, address: answeredEmail.senderEmail }],
      ccRecipients: replyRequest.cc,
      subject: replySubject(answeredEmail.subject),
      bodyText: replyRequest.text,
    });
    if (createResult.outcome === 'id_taken') {
      // Random UUIDs do not collide: this is a client reusing ids across mailboxes, or probing.
      console.warn('sent_mails id taken by another mailbox', { mailboxId: scope.mailboxId });
      throw createHttpError(409, 'sent_mail_id_taken');
    }
    // A replay of a row that already went out (or failed) just reports it. A row still `pending`
    // (crash between the insert and markSending) is resumed: markSending below still lets only one
    // request through.
    if (createResult.outcome === 'already_exists' && createResult.sentMail.status !== 'pending') {
      response
        .status(200)
        .json(
          toSentMailResponse(
            createResult.sentMail,
            await replyAttachmentRepository.listReplyAttachmentsOfSentMail(
              scope,
              createResult.sentMail.id,
            ),
          ),
        );
      return;
    }
    const pendingSentMail = createResult.sentMail;

    const { moved: claimedForSending } = await sentMailRepository.markSending(
      scope,
      pendingSentMail.id,
    );
    if (!claimedForSending) {
      // Another request with this id is sending right now; report the row as it stands.
      const sentMailNow = await sentMailRepository.findSentMail(scope, pendingSentMail.id);
      response
        .status(200)
        .json(
          toSentMailResponse(
            sentMailNow ?? pendingSentMail,
            await replyAttachmentRepository.listReplyAttachmentsOfSentMail(
              scope,
              pendingSentMail.id,
            ),
          ),
        );
      return;
    }

    let outboundAttachments: OutboundAttachment[] = [];
    if (replyAttachmentStore && attachments.length > 0) {
      try {
        outboundAttachments = await readOutboundAttachments(replyAttachmentStore, attachments);
      } catch (error) {
        // A file removed between the check and this read. Nothing has reached Gmail, so the row
        // fails and the client mints a new id.
        console.warn('reply attachment bytes unavailable', {
          sentMailId: pendingSentMail.id,
          error,
        });
        await sentMailRepository.markFailed(scope, pendingSentMail.id, 'attachment_not_found');
        throw createHttpError(409, 'attachment_not_found');
      }
    }
    const outboundMessage = {
      ...buildReplyMessage(pendingSentMail, answeredEmail, threadEmails, connection),
      inlineImages,
      ...(outboundAttachments.length > 0 ? { attachments: outboundAttachments } : {}),
    };

    let gmailSendResult;
    try {
      gmailSendResult = await gmailSender.sendMessage({
        credentials,
        refreshToken,
        message: outboundMessage,
        threadId: answeredEmail.gmailThreadId,
      });
    } catch (error) {
      // Only a 4xx proves Gmail did not take the mail. A timeout, reset or 5xx leaves the row in
      // `sending`: Gmail may have accepted it, the SENT copy will say, and a `failed` row would
      // invite a retry under a new id and a second copy at the vendor.
      if (isDefinitiveGmailRejection(error)) {
        try {
          await sentMailRepository.markFailed(scope, pendingSentMail.id, error.code);
        } catch (markFailedError) {
          // The send error is the one to report; the row stays `sending` for the operator to see.
          console.error('sent_mails markFailed failed', markFailedError);
        }
      }
      if (!(error instanceof GmailApiError)) throw error;
      // A dead refresh token blocks every later send and sync: flag the mailbox the way ingestion does.
      if (error.code === 'invalid_grant') {
        await mailboxConnectionRepository.markGmailNeedsReconnect(scope);
      }
      const sentMailAfterFailure = await sentMailRepository.findSentMail(scope, pendingSentMail.id);
      // A refused mail carries no files: they stay unsent for the retry.
      const body: SendReplyFailedResponse = {
        error: 'send_failed',
        sentMail: toSentMailResponse(sentMailAfterFailure ?? pendingSentMail),
      };
      response.status(502).json(body);
      return;
    }

    // Gmail has the mail from here on. This write sits outside the try on purpose: if it fails the
    // row stays `sending` (healed when the SENT copy is ingested) and must never be marked failed,
    // which would invite a retry under a new id and a second copy at the vendor. `moved` needs no
    // check: only the markSending winner reaches this line.
    await sentMailRepository.markSent(scope, pendingSentMail.id, gmailSendResult);
    if (attachments.length > 0) {
      const stamped = await replyAttachmentRepository.attachToSentMail(
        scope,
        attachments.map((attachment) => attachment.id),
        pendingSentMail.id,
      );
      // The mail went out with the bytes read above either way; a short count means a file was
      // removed in between and the row simply lists fewer files than it carried.
      if (stamped !== attachments.length) {
        console.warn('reply attachments changed during the send', {
          sentMailId: pendingSentMail.id,
          picked: attachments.length,
          stamped,
        });
      }
    }
    const sentMailAfterSend = await sentMailRepository.findSentMail(scope, pendingSentMail.id);
    response
      .status(201)
      .json(
        toSentMailResponse(
          sentMailAfterSend ?? pendingSentMail,
          await replyAttachmentRepository.listReplyAttachmentsOfSentMail(scope, pendingSentMail.id),
        ),
      );
  });

  return router;
}
