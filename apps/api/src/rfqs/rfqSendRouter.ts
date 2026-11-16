import { randomUUID } from 'node:crypto';
import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import {
  GmailApiError,
  buildOutboundMessageId,
  buildRfqMailMessage,
  isDefinitiveGmailRejection,
  mapWithConcurrency,
} from '@lc/core';
import type {
  EmailReadRepository,
  EncryptionUtil,
  GmailSender,
  MailboxConnectionRepository,
  MailboxScope,
  Rfq,
  RfqRepository,
  SentMail,
  SentMailRepository,
  SentMailToCreate,
  TenantRepository,
  Vendor,
  VendorContact,
  VendorRepository,
} from '@lc/core';
import { sendRfqBodySchema } from '@lc/contract';
import type {
  RfqMailText,
  RfqRecipient,
  RfqWithMailsResponse,
  SendRfqResponse,
} from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';
import { parseRequestBody } from '../http/parseRequestBody.js';
import { toRfqMailWithRepliesResponse, toRfqResponse } from './rfqResponses.js';
import { loadSendingMailbox } from '../sending/loadSendingMailbox.js';
import type { SendingMailbox } from '../sending/loadSendingMailbox.js';

export interface RfqSendRouterDependencies {
  emailReadRepository: EmailReadRepository;
  vendorRepository: VendorRepository;
  rfqRepository: RfqRepository;
  sentMailRepository: SentMailRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  tenantRepository: TenantRepository;
  gmailSender: GmailSender;
  encryptionUtil: EncryptionUtil;
  requireSession: RequestHandler;
}

/** Gmail sends in flight at once per request; enough for a desk-sized RFQ, gentle on the per-user quota. */
const CONCURRENT_GMAIL_SENDS = 2;

/**
 * Sending an RFQ to vendors and reading it back, mounted at /v1/mailbox/rfqs.
 *   PUT /:rfqId/send                 { sourceEmailId, details, recipients, mails }   see sendRfqBodySchema for codes
 *   GET /:rfqId                      the rfq and its mails, each with the replies it drew; polled while a mail is still `sending`
 *   GET /bySourceEmail/:emailId      the same for the newest rfq sent from that customer mail; 404 rfq_not_found when none was
 *
 * One `sent_mails` row and one fresh Gmail thread per contact. Write-ahead as for replies: the rfq
 * and its pending rows are written first, then each row moves pending -> sending -> sent | failed.
 * The request is a batch, so one refusal does not stop the others: 200 is always the answer once
 * the batch ran, and each mail carries its own status. The same PUT again (same rfqId) is the retry:
 * it sends what is still pending or failed and leaves sent and sending rows alone.
 */
export function createRfqSendRouter({
  emailReadRepository,
  vendorRepository,
  rfqRepository,
  sentMailRepository,
  mailboxConnectionRepository,
  tenantRepository,
  gmailSender,
  encryptionUtil,
  requireSession,
}: RfqSendRouterDependencies): Router {
  const router = express.Router();

  router.put('/:rfqId/send', requireSession, async (request, response) => {
    const scope = getSession(response);
    const rfqId = parseIdOr404(request.params.rfqId);
    const sendRequest = parseRequestBody(sendRfqBodySchema, request.body);

    const sourceEmail = await emailReadRepository.findEmail(scope, sendRequest.sourceEmailId);
    if (!sourceEmail) throw createHttpError(404, 'email_not_found');
    const recipientContacts = await resolveRecipientContacts(
      vendorRepository,
      scope.tenantId,
      sendRequest.recipients,
    );
    const mailTextByCategory = new Map(sendRequest.mails.map((mail) => [mail.category, mail]));
    if (recipientContacts.some(({ vendor }) => !mailTextByCategory.has(vendor.category))) {
      throw createHttpError(400, 'missing_mail_text');
    }
    const sendingMailbox = await loadSendingMailbox(
      { mailboxConnectionRepository, tenantRepository, encryptionUtil },
      scope,
    );

    const rfq = await createRfqOrReuseExisting(rfqRepository, scope, rfqId, sendRequest);
    const rfqMailsToCreate = recipientContacts.map(({ vendor, contact }) =>
      buildPendingRfqMail(
        rfq,
        vendor,
        contact,
        mailTextByCategory.get(vendor.category)!,
        sendingMailbox,
      ),
    );
    const rfqMails = await sentMailRepository.createPendingRfqMails(scope, rfqMailsToCreate);

    await sendPendingAndFailedMails(rfqMails, scope, sendingMailbox);

    const responseBody: SendRfqResponse = await rfqWithMails(scope, rfq);
    response.status(200).json(responseBody);
  });

  // Before GET /:rfqId, so "bySourceEmail" is never read as an rfqId.
  router.get('/bySourceEmail/:emailId', requireSession, async (request, response) => {
    const scope = getSession(response);
    const emailId = parseIdOr404(request.params.emailId);
    // The browser mints the rfqId when it sends and keeps it only in memory, so after a reload the
    // customer mail is the one handle left. One 404 covers "no RFQ" and "not this mailbox's mail":
    // the scoped lookup cannot tell them apart, and the panel shows the blank form for both.
    const rfq = await rfqRepository.findRfqBySourceEmail(scope, emailId);
    if (!rfq) throw createHttpError(404, 'rfq_not_found');
    const responseBody: RfqWithMailsResponse = await rfqWithMails(scope, rfq);
    response.status(200).json(responseBody);
  });

  router.get('/:rfqId', requireSession, async (request, response) => {
    const scope = getSession(response);
    const rfqId = parseIdOr404(request.params.rfqId);
    const rfq = await rfqRepository.findRfq(scope, rfqId);
    if (!rfq) throw createHttpError(404, 'rfq_not_found');
    const responseBody: RfqWithMailsResponse = await rfqWithMails(scope, rfq);
    response.status(200).json(responseBody);
  });

  async function rfqWithMails(scope: MailboxScope, rfq: Rfq): Promise<RfqWithMailsResponse> {
    return {
      rfq: toRfqResponse(rfq),
      mails: (await sentMailRepository.listRfqMails(scope, rfq.id)).map(
        toRfqMailWithRepliesResponse,
      ),
    };
  }

  /**
   * Sends every mail still pending or failed, CONCURRENT_GMAIL_SENDS at a time. A dead refresh token
   * stops the batch (every later send would fail the same way) and flags the mailbox for reconnect;
   * the rest stay pending for the retry after reconnecting.
   */
  async function sendPendingAndFailedMails(
    rfqMails: SentMail[],
    scope: MailboxScope,
    { connection, credentials, refreshToken }: SendingMailbox,
  ): Promise<void> {
    let mailboxNeedsReconnect = false;
    const mailsToSend = rfqMails.filter(
      (mail) => mail.status === 'pending' || mail.status === 'failed',
    );
    await mapWithConcurrency(mailsToSend, CONCURRENT_GMAIL_SENDS, async (mail) => {
      if (mailboxNeedsReconnect) return;
      const { moved: claimedForSending } =
        mail.status === 'failed'
          ? await sentMailRepository.markSendingAfterFailure(scope, mail.id)
          : await sentMailRepository.markSending(scope, mail.id);
      // Another request for this RFQ is sending this one right now; it will report it.
      if (!claimedForSending) return;
      let gmailSendResult;
      try {
        gmailSendResult = await gmailSender.sendMessage({
          credentials,
          refreshToken,
          message: buildRfqMailMessage(mail, connection),
        });
      } catch (error) {
        // Only a 4xx proves Gmail did not take the mail; anything else leaves the row in
        // `sending` for the SENT copy (or the operator) to resolve, never `failed`.
        if (isDefinitiveGmailRejection(error)) {
          await sentMailRepository.markFailed(scope, mail.id, error.code);
        } else {
          console.error('rfq send: outcome unknown, row left in sending', {
            sentMailId: mail.id,
            reason: error instanceof GmailApiError ? error.code : String(error),
          });
        }
        if (error instanceof GmailApiError && error.code === 'invalid_grant') {
          mailboxNeedsReconnect = true;
          await mailboxConnectionRepository.markGmailNeedsReconnect(scope);
        }
        return;
      }
      // Gmail has the mail from here on. Outside the try on purpose, as in emailRepliesRouter:
      // if this write fails the row stays `sending` (healed by the SENT copy), never `failed`.
      await sentMailRepository.markSent(scope, mail.id, gmailSendResult);
    });
  }

  return router;
}

interface RecipientContact {
  vendor: Vendor;
  contact: VendorContact;
}

/** Every (vendor, contact) the body names, in body order; 404 for anything unknown, archived or mismatched. */
async function resolveRecipientContacts(
  vendorRepository: VendorRepository,
  tenantId: string,
  recipients: RfqRecipient[],
): Promise<RecipientContact[]> {
  const vendors = await vendorRepository.listVendors(tenantId);
  const activeVendorById = new Map(
    vendors
      .filter((vendor) => vendor.active)
      .map((vendor): [string, Vendor] => [vendor.id, vendor]),
  );
  return recipients.flatMap((recipient) => {
    const vendor = activeVendorById.get(recipient.vendorId);
    if (!vendor) throw createHttpError(404, 'vendor_not_found');
    return recipient.contactIds.map((contactId) => {
      const contact = vendor.contacts.find((candidate) => candidate.id === contactId);
      if (!contact || !contact.active) throw createHttpError(404, 'contact_not_found');
      return { vendor, contact };
    });
  });
}

/** The rfq row for this request: freshly written, or the one an earlier call with the same id wrote. */
async function createRfqOrReuseExisting(
  rfqRepository: RfqRepository,
  scope: MailboxScope,
  rfqId: string,
  sendRequest: {
    sourceEmailId: string;
    details: { originPort: string; destinationPort: string; incoterm: string | null };
  },
): Promise<Rfq> {
  const createResult = await rfqRepository.createRfq(scope, {
    id: rfqId,
    sourceEmailId: sendRequest.sourceEmailId,
    originPort: sendRequest.details.originPort,
    destinationPort: sendRequest.details.destinationPort,
    incoterm: sendRequest.details.incoterm,
  });
  if (createResult.outcome === 'id_taken') {
    console.warn('rfqs id taken by another mailbox', { mailboxId: scope.mailboxId });
    throw createHttpError(409, 'rfq_id_taken');
  }
  // A replay must be the same request: the id is reused for another mail only by mistake.
  if (createResult.rfq.sourceEmailId !== sendRequest.sourceEmailId) {
    throw createHttpError(409, 'rfq_id_taken');
  }
  return createResult.rfq;
}

function buildPendingRfqMail(
  rfq: Rfq,
  vendor: Vendor,
  contact: VendorContact,
  mailText: RfqMailText,
  { connection }: SendingMailbox,
): SentMailToCreate {
  const sentMailId = randomUUID();
  return {
    id: sentMailId,
    kind: 'rfq',
    inReplyToEmailId: null,
    rfqId: rfq.id,
    vendorId: vendor.id,
    vendorContactId: contact.id,
    gmailThreadId: null,
    rfcMessageId: buildOutboundMessageId(sentMailId, connection.emailAddress),
    toRecipients: [{ name: contact.contactName, address: contact.emailAddress }],
    ccRecipients: [],
    subject: mailText.subject,
    bodyText: mailText.bodyText,
  };
}
