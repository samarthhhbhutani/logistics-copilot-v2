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
  GoogleOAuthClientCredentials,
  MailboxConnection,
  MailboxConnectionRepository,
  MailboxScope,
  SentMailRepository,
  TenantRepository,
} from '@lc/core';
import { sendReplyRequestSchema } from '@lc/contract';
import type { SendReplyFailedResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';
import { parseRequestBody } from '../http/parseRequestBody.js';
import { toSentMailResponse } from './sentMailResponses.js';

export interface EmailRepliesRouterDependencies {
  emailReadRepository: EmailReadRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  tenantRepository: TenantRepository;
  sentMailRepository: SentMailRepository;
  gmailSender: GmailSender;
  encryptionUtil: EncryptionUtil;
  requireSession: RequestHandler;
}

/**
 * Replying to an inbound mail from the signed-in mailbox, mounted at /v1/mailbox/emails.
 *   POST /:emailId/replies  { sentMailId, text, cc? }
 *     201 SentMailResponse (sent)            404 mail outside the session's mailbox and tenant
 *     200 SentMailResponse (same sentMailId  409 not_inbound | no_sender | mailbox_not_connected |
 *         seen before: idempotent replay,        google_client_not_configured | sent_mail_id_taken
 *         body differences ignored)
 *     502 { error: send_failed, sentMail }   sentMail.status is `failed` when Gmail rejected it (4xx) or
 *                                            `sending` when the outcome is unknown (timeout, 5xx)
 *
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
  requireSession,
}: EmailRepliesRouterDependencies): Router {
  const router = express.Router();

  async function loadSendingMailbox(scope: MailboxScope): Promise<{
    connection: MailboxConnection;
    credentials: GoogleOAuthClientCredentials;
    refreshToken: string;
  }> {
    const connection = await mailboxConnectionRepository.findMailboxConnection(scope);
    if (!connection) throw createHttpError(404, 'mailbox_not_found');
    if (connection.gmailConnectionStatus !== 'connected' || !connection.encryptedRefreshToken) {
      throw createHttpError(409, 'mailbox_not_connected');
    }
    const tenantClient = await tenantRepository.findTenantGoogleClient(scope.tenantId);
    if (!tenantClient) throw createHttpError(409, 'google_client_not_configured');
    return {
      connection,
      credentials: {
        clientId: tenantClient.clientId,
        clientSecret: encryptionUtil.decryptSecret(tenantClient.encryptedClientSecret),
      },
      refreshToken: encryptionUtil.decryptSecret(connection.encryptedRefreshToken),
    };
  }

  router.post('/:emailId/replies', requireSession, async (request, response) => {
    const scope = getSession(response);
    const emailId = parseIdOr404(request.params.emailId);
    const replyRequest = parseRequestBody(sendReplyRequestSchema, request.body);

    const answeredEmail = await emailReadRepository.findEmail(scope, emailId);
    if (!answeredEmail) throw createHttpError(404, 'not_found');
    if (answeredEmail.gmailLabel !== 'inbox') throw createHttpError(409, 'not_inbound');
    if (!answeredEmail.senderEmail) throw createHttpError(409, 'no_sender');
    const { connection, credentials, refreshToken } = await loadSendingMailbox(scope);

    const threadEmails = await emailReadRepository.listThreadEmails(
      scope,
      answeredEmail.gmailThreadId,
    );
    const rfcMessageId = buildOutboundMessageId(replyRequest.sentMailId, connection.emailAddress);
    const createResult = await sentMailRepository.createPending(scope, {
      id: replyRequest.sentMailId,
      kind: 'reply',
      inReplyToEmailId: answeredEmail.id,
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
      response.status(200).json(toSentMailResponse(createResult.sentMail));
      return;
    }
    const pendingSentMail = createResult.sentMail;

    const outboundMessage = buildReplyMessage(
      pendingSentMail,
      answeredEmail,
      threadEmails,
      connection,
    );
    const { moved: claimedForSending } = await sentMailRepository.markSending(
      scope,
      pendingSentMail.id,
    );
    if (!claimedForSending) {
      // Another request with this id is sending right now; report the row as it stands.
      const sentMailNow = await sentMailRepository.findSentMail(scope, pendingSentMail.id);
      response.status(200).json(toSentMailResponse(sentMailNow ?? pendingSentMail));
      return;
    }

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
    const sentMailAfterSend = await sentMailRepository.findSentMail(scope, pendingSentMail.id);
    response.status(201).json(toSentMailResponse(sentMailAfterSend ?? pendingSentMail));
  });

  return router;
}
