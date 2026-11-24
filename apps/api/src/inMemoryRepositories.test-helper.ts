import { randomUUID } from 'node:crypto';
import { MAX_CLASSIFICATION_RULES_PER_TENANT } from '@lc/core';
import type {
  AgentRun,
  AgentRunRepository,
  AttachmentRepository,
  AttachmentSummary,
  ClassificationRule,
  Vendor,
  VendorRepository,
  ClassificationRuleRepository,
  EmailClassificationRepository,
  CurrentClassification,
  EmailDetail,
  EmailReadRepository,
  EmailSummary,
  MailboxConnection,
  MailboxConnectionRepository,
  MailboxCredentials,
  MailboxCredentialsRepository,
  OutboundAttachment,
  OutboundAttachmentRepository,
  Rfq,
  RfqRepository,
  SentMail,
  SentMailRepository,
  SentMailStatus,
  SignatureImage,
  SignatureImageRepository,
  TenantGoogleClient,
  TenantPubsubPush,
  TenantRepository,
} from '@lc/core';

/** Test doubles with the same contracts as the Prisma repositories, no database. */
export function createInMemoryRepositories(): {
  tenantRepository: TenantRepository;
  mailboxCredentialsRepository: MailboxCredentialsRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  emailReadRepository: EmailReadRepository;
  attachmentRepository: AttachmentRepository;
  classificationRuleRepository: ClassificationRuleRepository;
  vendorRepository: VendorRepository;
  emailClassificationRepository: EmailClassificationRepository;
  sentMailRepository: SentMailRepository;
  rfqRepository: RfqRepository;
  signatureImageRepository: SignatureImageRepository;
  outboundAttachmentRepository: OutboundAttachmentRepository;
  agentRunRepository: AgentRunRepository;
  /** Seeds the inbox list directly; the processor's insert path is not part of the API. Detail fields default to empty. */
  addEmail(
    email: Omit<EmailSummary, 'classification'> &
      Partial<Pick<EmailSummary, 'classification'>> &
      Partial<Omit<EmailDetail, keyof EmailSummary>> & {
        mailboxId: string;
        tenantId: string;
        /** The RFQ mail of ours this email answers (emails.answers_sent_mail_id); unlinked when omitted. */
        answersSentMailId?: string;
      },
  ): void;
  /** Sets the current classification of a seeded email. */
  setClassification(emailId: string, classification: CurrentClassification): void;
  /** Seeds a stored file on a seeded email; tenantId is the row's own isolation column. */
  addAttachment(attachment: AttachmentSummary & { tenantId: string }): void;
} {
  const googleClientByTenantId = new Map<string, TenantGoogleClient>();
  const pubsubPushByTenantId = new Map<string, TenantPubsubPush>();
  const credentialsByEmail = new Map<string, MailboxCredentials>();
  const connectionByMailboxId = new Map<string, MailboxConnection>();
  const emails: (EmailDetail & {
    mailboxId: string;
    tenantId: string;
    answersSentMailId?: string;
  })[] = [];
  const sentMails: (SentMail & { mailboxId: string; tenantId: string })[] = [];
  const rfqs: (Rfq & { mailboxId: string; tenantId: string })[] = [];
  const signatureImages: (SignatureImage & { mailboxId: string; tenantId: string })[] = [];
  const outboundAttachments: (OutboundAttachment & { mailboxId: string; tenantId: string })[] = [];
  const agentRuns: (AgentRun & { mailboxId: string; tenantId: string })[] = [];

  function emailsInScope({ mailboxId, tenantId }: { mailboxId: string; tenantId: string }) {
    return emails.filter((email) => email.mailboxId === mailboxId && email.tenantId === tenantId);
  }
  const attachments: (AttachmentSummary & { tenantId: string })[] = [];
  const classificationRules: (ClassificationRule & { tenantId: string })[] = [];
  const vendors: (Vendor & { tenantId: string })[] = [];

  /** The email must be in the scope's mailbox and tenant, and the attachment row in the same tenant. */
  function attachmentsOf(scope: { mailboxId: string; tenantId: string }, emailId: string) {
    const email = emails.find(
      (candidate) =>
        candidate.id === emailId &&
        candidate.mailboxId === scope.mailboxId &&
        candidate.tenantId === scope.tenantId,
    );
    if (!email) return undefined;
    return attachments.filter(
      (attachment) => attachment.emailId === emailId && attachment.tenantId === scope.tenantId,
    );
  }

  /** Same guard as the Prisma repository: the row moves only if it is currently in `from`. */
  async function moveSentMail(
    scope: { mailboxId: string; tenantId: string },
    sentMailId: string,
    transition: { from: SentMailStatus; to: SentMailStatus },
    changes: Partial<Pick<SentMail, 'gmailMessageId' | 'gmailThreadId' | 'errorCode'>>,
  ): Promise<{ moved: boolean }> {
    const sentMail = sentMails.find(
      (candidate) =>
        candidate.id === sentMailId &&
        candidate.mailboxId === scope.mailboxId &&
        candidate.tenantId === scope.tenantId &&
        candidate.status === transition.from,
    );
    if (!sentMail) return { moved: false };
    Object.assign(sentMail, changes, { status: transition.to, updatedAt: new Date() });
    return { moved: true };
  }

  function agentRunInScope(scope: { mailboxId: string; tenantId: string }, agentRunId: string) {
    return agentRuns.find(
      (candidate) =>
        candidate.id === agentRunId &&
        candidate.mailboxId === scope.mailboxId &&
        candidate.tenantId === scope.tenantId,
    );
  }
  /** Same guard as the Prisma repository: only a running row moves. */
  async function finishAgentRun(
    scope: { mailboxId: string; tenantId: string },
    agentRunId: string,
    changes: Pick<AgentRun, 'status' | 'toolCalls' | 'usage'> &
      Partial<Pick<AgentRun, 'proposal' | 'errorCode'>>,
  ): Promise<{ moved: boolean }> {
    const run = agentRunInScope(scope, agentRunId);
    if (!run || run.status !== 'running') return { moved: false };
    Object.assign(run, changes, { finishedAt: new Date() });
    return { moved: true };
  }

  function findInTenant(scope: { mailboxId: string; tenantId: string }) {
    const connection = connectionByMailboxId.get(scope.mailboxId);
    return connection?.tenantId === scope.tenantId ? connection : undefined;
  }

  return {
    tenantRepository: {
      async createTenant({
        googleClientId,
        encryptedGoogleClientSecret,
        pubsubTopicName,
        pushServiceAccountEmail,
      }) {
        const tenantId = randomUUID();
        googleClientByTenantId.set(tenantId, {
          clientId: googleClientId,
          encryptedClientSecret: encryptedGoogleClientSecret,
        });
        pubsubPushByTenantId.set(tenantId, { topicName: pubsubTopicName, pushServiceAccountEmail });
        return { tenantId };
      },
      async tenantExists(tenantId) {
        return googleClientByTenantId.has(tenantId);
      },
      async findTenantGoogleClient(tenantId) {
        return googleClientByTenantId.get(tenantId);
      },
      async findTenantPubsubPush(tenantId) {
        return pubsubPushByTenantId.get(tenantId);
      },
    },
    mailboxCredentialsRepository: {
      async findMailboxCredentials(emailAddress) {
        return credentialsByEmail.get(emailAddress);
      },
      async createMailboxCredentials({ tenantId, emailAddress, passwordHash }) {
        const credentials = { mailboxId: randomUUID(), tenantId, passwordHash };
        credentialsByEmail.set(emailAddress, credentials);
        connectionByMailboxId.set(credentials.mailboxId, {
          mailboxId: credentials.mailboxId,
          tenantId,
          emailAddress,
          gmailConnectionStatus: 'not_connected',
          gmailConnectedAt: null,
          encryptedRefreshToken: null,
          watchExpiresAt: null,
          signature: null,
          signatureHtml: null,
        });
        return credentials;
      },
    },
    emailReadRepository: {
      async listEmails({ mailboxId, tenantId }, { limit, gmailLabel, classification, before }) {
        return emails
          .filter((email) => email.mailboxId === mailboxId && email.tenantId === tenantId)
          .filter((email) => !gmailLabel || email.gmailLabel === gmailLabel)
          .filter((email) => !classification || email.classification?.label === classification)
          .filter(
            (email) =>
              !before ||
              email.receivedAt < before.receivedAt ||
              (email.receivedAt.getTime() === before.receivedAt.getTime() && email.id < before.id),
          )
          .sort(
            (left, right) =>
              right.receivedAt.getTime() - left.receivedAt.getTime() ||
              (right.id > left.id ? 1 : -1),
          )
          .slice(0, limit);
      },
      async findEmail(scope, emailId) {
        return emailsInScope(scope).find((email) => email.id === emailId);
      },
      async listThreadEmails(scope, gmailThreadId) {
        return emailsInScope(scope)
          .filter((email) => email.gmailThreadId === gmailThreadId)
          .sort(
            (left, right) =>
              left.receivedAt.getTime() - right.receivedAt.getTime() ||
              (left.id > right.id ? 1 : -1),
          );
      },
      async listEmailsByGmailMessageIds(scope, gmailMessageIds) {
        return emailsInScope(scope).filter((email) =>
          gmailMessageIds.includes(email.gmailMessageId),
        );
      },
    },
    attachmentRepository: {
      async listAttachments(scope, emailId) {
        return attachmentsOf(scope, emailId)?.sort(
          (left, right) =>
            Number(left.isInline) - Number(right.isInline) ||
            left.fileName.localeCompare(right.fileName),
        );
      },
      async findAttachment(scope, emailId, attachmentId) {
        return attachmentsOf(scope, emailId)?.find((attachment) => attachment.id === attachmentId);
      },
    },
    vendorRepository: {
      async listVendors(tenantId) {
        return vendors
          .filter((vendor) => vendor.tenantId === tenantId)
          .sort((left, right) => left.vendorName.localeCompare(right.vendorName));
      },
      async createVendor(tenantId, vendorToCreate) {
        const nameTaken = vendors.some(
          (vendor) =>
            vendor.tenantId === tenantId &&
            vendor.vendorName.toLowerCase() === vendorToCreate.vendorName.toLowerCase(),
        );
        if (nameTaken) return { outcome: 'vendor_name_taken' };
        const now = new Date();
        const vendor: Vendor & { tenantId: string } = {
          id: randomUUID(),
          tenantId,
          vendorName: vendorToCreate.vendorName,
          category: vendorToCreate.category,
          notes: vendorToCreate.notes,
          active: true,
          contacts: vendorToCreate.contacts
            .map((contact) => ({
              id: randomUUID(),
              contactName: contact.contactName,
              emailAddress: contact.emailAddress,
              phoneNumber: contact.phoneNumber,
              active: true,
              createdAt: now,
              updatedAt: now,
            }))
            .sort((left, right) => left.contactName.localeCompare(right.contactName)),
          createdAt: now,
          updatedAt: now,
        };
        vendors.push(vendor);
        return { outcome: 'created', vendor };
      },
      async updateVendor(tenantId, vendorId, changes) {
        const vendor = vendors.find(
          (candidate) => candidate.id === vendorId && candidate.tenantId === tenantId,
        );
        if (!vendor) return { outcome: 'vendor_not_found' };
        if (
          changes.vendorName !== undefined &&
          vendors.some(
            (candidate) =>
              candidate.tenantId === tenantId &&
              candidate.id !== vendorId &&
              candidate.vendorName.toLowerCase() === changes.vendorName!.toLowerCase(),
          )
        ) {
          return { outcome: 'vendor_name_taken' };
        }
        Object.assign(vendor, changes, { updatedAt: new Date() });
        return { outcome: 'updated', vendor };
      },
      async addContact(tenantId, vendorId, contactToAdd) {
        const vendor = vendors.find(
          (candidate) => candidate.id === vendorId && candidate.tenantId === tenantId,
        );
        if (!vendor) return { outcome: 'vendor_not_found' };
        if (vendor.contacts.some((contact) => contact.emailAddress === contactToAdd.emailAddress)) {
          return { outcome: 'contact_email_taken' };
        }
        const now = new Date();
        vendor.contacts.push({
          id: randomUUID(),
          ...contactToAdd,
          active: true,
          createdAt: now,
          updatedAt: now,
        });
        vendor.contacts.sort((left, right) => left.contactName.localeCompare(right.contactName));
        return { outcome: 'added', vendor };
      },
      async updateContact(tenantId, vendorId, contactId, changes) {
        const vendor = vendors.find(
          (candidate) => candidate.id === vendorId && candidate.tenantId === tenantId,
        );
        const contact = vendor?.contacts.find((candidate) => candidate.id === contactId);
        if (!vendor || !contact) return { outcome: 'contact_not_found' };
        if (
          changes.emailAddress !== undefined &&
          vendor.contacts.some(
            (candidate) =>
              candidate.id !== contactId && candidate.emailAddress === changes.emailAddress,
          )
        ) {
          return { outcome: 'contact_email_taken' };
        }
        Object.assign(contact, changes, { updatedAt: new Date() });
        vendor.contacts.sort((left, right) => left.contactName.localeCompare(right.contactName));
        return { outcome: 'updated', vendor };
      },
    },
    classificationRuleRepository: {
      async listEnabledRules(tenantId) {
        return classificationRules
          .filter((rule) => rule.tenantId === tenantId && rule.enabled)
          .sort((left, right) => left.priority - right.priority);
      },
      async listRules(tenantId) {
        return classificationRules
          .filter((rule) => rule.tenantId === tenantId)
          .sort((left, right) => left.priority - right.priority);
      },
      async createRule(tenantId, newRule) {
        const tenantRules = classificationRules.filter((rule) => rule.tenantId === tenantId);
        if (tenantRules.length >= MAX_CLASSIFICATION_RULES_PER_TENANT) {
          return { outcome: 'too_many_rules' };
        }
        if (tenantRules.some((rule) => rule.senderPattern === newRule.senderPattern)) {
          return { outcome: 'duplicate_pattern' };
        }
        const rule = {
          id: randomUUID(),
          ...newRule,
          enabled: true,
          createdAt: new Date(),
          tenantId,
        };
        classificationRules.push(rule);
        return { outcome: 'created', rule };
      },
    },
    emailClassificationRepository: {
      async appendUserClassification(scope, emailId, label) {
        const email = emailsInScope(scope).find((candidate) => candidate.id === emailId);
        if (!email) return { outcome: 'not_found' };
        if (email.gmailLabel !== 'inbox') return { outcome: 'not_inbound' };
        const classification = {
          label,
          source: 'user' as const,
          confidence: null,
          classifiedAt: new Date(),
        };
        email.classification = classification;
        return { outcome: 'appended', classification };
      },
    },
    addEmail(email) {
      emails.push({
        ccRecipients: [],
        gmailMessageId: `gmail-${email.id}`,
        rfcMessageId: null,
        bodyText: '',
        bodyHtml: null,
        classification: null,
        ...email,
      });
    },
    setClassification(emailId, classification) {
      const email = emails.find((candidate) => candidate.id === emailId);
      if (!email) throw new Error(`no seeded email ${emailId}`);
      email.classification = classification;
    },
    addAttachment(attachment) {
      attachments.push(attachment);
    },
    sentMailRepository: {
      async createPending(scope, sentMail) {
        const existing = sentMails.find((candidate) => candidate.id === sentMail.id);
        if (existing) {
          return existing.mailboxId === scope.mailboxId && existing.tenantId === scope.tenantId
            ? { outcome: 'already_exists', sentMail: existing }
            : { outcome: 'id_taken' };
        }
        const now = new Date();
        const created = {
          ...sentMail,
          ...scope,
          status: 'pending' as const,
          gmailMessageId: null,
          errorCode: null,
          createdAt: now,
          updatedAt: now,
        };
        sentMails.push(created);
        return { outcome: 'created', sentMail: created };
      },
      async findSentMail(scope, sentMailId) {
        return sentMails.find(
          (candidate) =>
            candidate.id === sentMailId &&
            candidate.mailboxId === scope.mailboxId &&
            candidate.tenantId === scope.tenantId,
        );
      },
      async createPendingRfqMails(scope, mailsToCreate) {
        const rfqId = mailsToCreate[0]?.rfqId;
        if (!rfqId) throw new Error('createPendingRfqMails needs one rfqId');
        for (const mailToCreate of mailsToCreate) {
          // Same guard as the unique (rfq_id, vendor_contact_id): the contact's existing row stays.
          const duplicate = sentMails.some(
            (candidate) =>
              candidate.rfqId === rfqId &&
              candidate.vendorContactId === mailToCreate.vendorContactId,
          );
          if (duplicate) continue;
          const now = new Date();
          sentMails.push({
            ...mailToCreate,
            ...scope,
            status: 'pending',
            gmailMessageId: null,
            errorCode: null,
            createdAt: now,
            updatedAt: now,
          });
        }
        return this.listRfqMails(scope, rfqId);
      },
      async listRfqMails(scope, rfqId) {
        return sentMails
          .filter(
            (candidate) =>
              candidate.rfqId === rfqId &&
              candidate.mailboxId === scope.mailboxId &&
              candidate.tenantId === scope.tenantId,
          )
          .map((rfqMail) => {
            // Newest first by receivedAt, as the Prisma take-1 include orders them.
            const replies = emails
              .filter((email) => email.answersSentMailId === rfqMail.id)
              .sort((left, right) => right.receivedAt.getTime() - left.receivedAt.getTime());
            const latestReply = replies[0];
            return {
              ...rfqMail,
              replies: {
                count: replies.length,
                latest: latestReply
                  ? {
                      emailId: latestReply.id,
                      senderName: latestReply.senderName,
                      senderEmail: latestReply.senderEmail,
                      receivedAt: latestReply.receivedAt,
                      snippet: latestReply.snippet,
                      classification: latestReply.classification,
                    }
                  : undefined,
              },
            };
          });
      },
      markSending: (scope, sentMailId) =>
        moveSentMail(scope, sentMailId, { from: 'pending', to: 'sending' }, {}),
      markSendingAfterFailure: (scope, sentMailId) =>
        moveSentMail(scope, sentMailId, { from: 'failed', to: 'sending' }, { errorCode: null }),
      markSent: (scope, sentMailId, gmailIds) =>
        moveSentMail(
          scope,
          sentMailId,
          { from: 'sending', to: 'sent' },
          { ...gmailIds, errorCode: null },
        ),
      markFailed: (scope, sentMailId, errorCode) =>
        moveSentMail(scope, sentMailId, { from: 'sending', to: 'failed' }, { errorCode }),
      async markFailedByRfcMessageId(scope, rfcMessageId, errorCode) {
        const sentMail = sentMails.find(
          (candidate) =>
            candidate.rfcMessageId === rfcMessageId &&
            candidate.mailboxId === scope.mailboxId &&
            candidate.tenantId === scope.tenantId,
        );
        if (!sentMail) return { moved: false };
        return moveSentMail(scope, sentMail.id, { from: 'sending', to: 'failed' }, { errorCode });
      },
      async listStaleSending() {
        throw new Error('the API never sweeps; the sweeper Lambda does');
      },
      async findAnsweredSentMail() {
        throw new Error('the API never links inbound mail; the processor Lambda does');
      },
      async markSentByRfcMessageId(scope, rfcMessageId, gmailIds) {
        const sentMail = sentMails.find(
          (candidate) =>
            candidate.rfcMessageId === rfcMessageId &&
            candidate.mailboxId === scope.mailboxId &&
            candidate.tenantId === scope.tenantId,
        );
        if (!sentMail) return { moved: false };
        return moveSentMail(
          scope,
          sentMail.id,
          { from: 'sending', to: 'sent' },
          { ...gmailIds, errorCode: null },
        );
      },
    },
    agentRunRepository: {
      async create(scope, run) {
        const created: AgentRun & { mailboxId: string; tenantId: string } = {
          ...scope,
          id: randomUUID(),
          emailId: run.emailId,
          gmailThreadId: run.gmailThreadId,
          instruction: run.instruction,
          status: 'running',
          proposal: null,
          toolCalls: [],
          model: run.model,
          promptVersion: run.promptVersion,
          usage: { inputTokens: 0, outputTokens: 0 },
          errorCode: null,
          createdAt: new Date(),
          finishedAt: null,
        };
        agentRuns.push(created);
        return stripRunScope(created);
      },
      async findAgentRun(scope, agentRunId) {
        const run = agentRunInScope(scope, agentRunId);
        return run ? stripRunScope(run) : null;
      },
      async listForThread(scope, gmailThreadId, limit) {
        return agentRuns
          .filter(
            (run) =>
              run.mailboxId === scope.mailboxId &&
              run.tenantId === scope.tenantId &&
              run.gmailThreadId === gmailThreadId,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map(stripRunScope);
      },
      markProposed(scope, agentRunId, { toolCalls, usage, proposal }) {
        return finishAgentRun(scope, agentRunId, {
          status: 'proposed',
          toolCalls,
          usage,
          proposal,
        });
      },
      markFailed(scope, agentRunId, { toolCalls, usage, errorCode }) {
        return finishAgentRun(scope, agentRunId, { status: 'failed', toolCalls, usage, errorCode });
      },
    },
    signatureImageRepository: {
      async listSignatureImages({ mailboxId, tenantId }) {
        return signatureImages
          .filter((image) => image.mailboxId === mailboxId && image.tenantId === tenantId)
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .map(stripScope);
      },
      async findSignatureImages({ mailboxId, tenantId }, imageIds) {
        return imageIds.flatMap((imageId) => {
          const image = signatureImages.find(
            (candidate) =>
              candidate.id === imageId &&
              candidate.mailboxId === mailboxId &&
              candidate.tenantId === tenantId,
          );
          return image ? [stripScope(image)] : [];
        });
      },
      async createSignatureImage({ mailboxId, tenantId }, imageToCreate) {
        const image = {
          ...imageToCreate,
          createdAt: new Date(2026, 0, 1, 0, 0, signatureImages.length),
          mailboxId,
          tenantId,
        };
        signatureImages.push(image);
        return stripScope(image);
      },
      async deleteSignatureImage({ mailboxId, tenantId }, imageId) {
        const index = signatureImages.findIndex(
          (image) =>
            image.id === imageId && image.mailboxId === mailboxId && image.tenantId === tenantId,
        );
        if (index === -1) return undefined;
        const [removed] = signatureImages.splice(index, 1);
        return removed ? stripScope(removed) : undefined;
      },
    },
    outboundAttachmentRepository: {
      async createOutboundAttachment({ mailboxId, tenantId }, attachmentToCreate) {
        const attachment = {
          ...attachmentToCreate,
          sentMailId: null,
          createdAt: new Date(2026, 0, 1, 0, 0, outboundAttachments.length),
          mailboxId,
          tenantId,
        };
        outboundAttachments.push(attachment);
        return stripAttachmentScope(attachment);
      },
      async findOutboundAttachments({ mailboxId, tenantId }, attachmentIds) {
        return attachmentIds.flatMap((attachmentId) => {
          const attachment = outboundAttachments.find(
            (candidate) =>
              candidate.id === attachmentId &&
              candidate.mailboxId === mailboxId &&
              candidate.tenantId === tenantId,
          );
          return attachment ? [stripAttachmentScope(attachment)] : [];
        });
      },
      async listOutboundAttachmentsOfSentMail({ mailboxId, tenantId }, sentMailId) {
        return outboundAttachments
          .filter(
            (attachment) =>
              attachment.sentMailId === sentMailId &&
              attachment.mailboxId === mailboxId &&
              attachment.tenantId === tenantId,
          )
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .map(stripAttachmentScope);
      },
      async attachToSentMail({ mailboxId, tenantId }, attachmentIds, sentMailId) {
        let changed = 0;
        for (const attachment of outboundAttachments) {
          if (
            attachmentIds.includes(attachment.id) &&
            attachment.mailboxId === mailboxId &&
            attachment.tenantId === tenantId &&
            attachment.sentMailId === null
          ) {
            attachment.sentMailId = sentMailId;
            changed += 1;
          }
        }
        return changed;
      },
      async deleteUnsentOutboundAttachment({ mailboxId, tenantId }, attachmentId) {
        const index = outboundAttachments.findIndex(
          (attachment) =>
            attachment.id === attachmentId &&
            attachment.mailboxId === mailboxId &&
            attachment.tenantId === tenantId &&
            attachment.sentMailId === null,
        );
        if (index === -1) return undefined;
        const [removed] = outboundAttachments.splice(index, 1);
        return removed ? stripAttachmentScope(removed) : undefined;
      },
    },
    rfqRepository: {
      async listRfqs(scope, { limit, before }) {
        return rfqs
          .filter(
            (candidate) =>
              candidate.mailboxId === scope.mailboxId &&
              candidate.tenantId === scope.tenantId &&
              (!before ||
                candidate.createdAt < before.createdAt ||
                (candidate.createdAt.getTime() === before.createdAt.getTime() &&
                  candidate.id < before.id)),
          )
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime() ||
              right.id.localeCompare(left.id),
          )
          .slice(0, limit)
          .map((rfq) => {
            const sourceEmail = emails.find((email) => email.id === rfq.sourceEmailId);
            if (!sourceEmail) throw new Error(`rfq ${rfq.id} has no seeded source email`);
            const reachableMails = sentMails.filter(
              (sentMail) => sentMail.rfqId === rfq.id && sentMail.status !== 'failed',
            );
            const newestReplyLabels = reachableMails.map((sentMail) => {
              const newestReply = emails
                .filter((email) => email.answersSentMailId === sentMail.id)
                .sort((left, right) => right.receivedAt.getTime() - left.receivedAt.getTime())[0];
              return newestReply
                ? (newestReply.classification?.label ?? 'unclassified')
                : undefined;
            });
            return {
              rfq,
              sourceEmail: {
                id: sourceEmail.id,
                senderName: sourceEmail.senderName,
                senderEmail: sourceEmail.senderEmail,
                subject: sourceEmail.subject,
                receivedAt: sourceEmail.receivedAt,
              },
              replies: {
                contactCount: reachableMails.length,
                repliedCount: newestReplyLabels.filter((label) => label !== undefined).length,
                quoteCount: newestReplyLabels.filter((label) => label === 'vendor_quote').length,
              },
            };
          });
      },
      async createRfq(scope, rfqToCreate) {
        const existing = rfqs.find((candidate) => candidate.id === rfqToCreate.id);
        if (existing) {
          return existing.mailboxId === scope.mailboxId && existing.tenantId === scope.tenantId
            ? { outcome: 'already_exists', rfq: existing }
            : { outcome: 'id_taken' };
        }
        const now = new Date();
        const created = {
          ...rfqToCreate,
          ...scope,
          status: 'open' as const,
          createdAt: now,
          updatedAt: now,
        };
        rfqs.push(created);
        return { outcome: 'created', rfq: created };
      },
      async findRfq(scope, rfqId) {
        return rfqs.find(
          (candidate) =>
            candidate.id === rfqId &&
            candidate.mailboxId === scope.mailboxId &&
            candidate.tenantId === scope.tenantId,
        );
      },
      async findRfqBySourceEmail(scope, sourceEmailId) {
        // Newest first, as the Prisma query orders them.
        return rfqs
          .filter(
            (candidate) =>
              candidate.sourceEmailId === sourceEmailId &&
              candidate.mailboxId === scope.mailboxId &&
              candidate.tenantId === scope.tenantId,
          )
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
      },
    },
    mailboxConnectionRepository: {
      async findMailboxConnection(scope) {
        return findInTenant(scope);
      },
      async saveGmailConnection(scope, { encryptedRefreshToken, watchExpiresAt }) {
        const connection = findInTenant(scope);
        if (!connection) return;
        connection.encryptedRefreshToken = encryptedRefreshToken;
        connection.gmailConnectionStatus = 'connected';
        connection.gmailConnectedAt = new Date();
        connection.watchExpiresAt = watchExpiresAt;
      },
      async markGmailNeedsReconnect(scope) {
        const connection = findInTenant(scope);
        if (connection) connection.gmailConnectionStatus = 'needs_reconnect';
      },
      async clearGmailConnection(scope) {
        const connection = findInTenant(scope);
        if (!connection) return;
        connection.encryptedRefreshToken = null;
        connection.gmailConnectionStatus = 'not_connected';
        connection.gmailConnectedAt = null;
        connection.watchExpiresAt = null;
      },
      async updateSignature(scope, { signature, signatureHtml }) {
        const connection = findInTenant(scope);
        if (connection) {
          connection.signature = signature;
          connection.signatureHtml = signatureHtml;
        }
      },
    },
  };
}

function stripRunScope(run: AgentRun & { mailboxId: string; tenantId: string }): AgentRun {
  return {
    id: run.id,
    emailId: run.emailId,
    gmailThreadId: run.gmailThreadId,
    instruction: run.instruction,
    status: run.status,
    proposal: run.proposal,
    toolCalls: [...run.toolCalls],
    model: run.model,
    promptVersion: run.promptVersion,
    usage: { ...run.usage },
    errorCode: run.errorCode,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  };
}

/** The repository contract has no scope columns on the row; the store keeps them for isolation. */
function stripScope(
  image: SignatureImage & { mailboxId: string; tenantId: string },
): SignatureImage {
  return {
    id: image.id,
    fileName: image.fileName,
    contentType: image.contentType,
    sizeBytes: image.sizeBytes,
    s3Key: image.s3Key,
    createdAt: image.createdAt,
  };
}

function stripAttachmentScope(
  attachment: OutboundAttachment & { mailboxId: string; tenantId: string },
): OutboundAttachment {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    s3Key: attachment.s3Key,
    sentMailId: attachment.sentMailId,
    createdAt: attachment.createdAt,
  };
}
