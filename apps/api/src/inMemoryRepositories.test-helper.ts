import { randomUUID } from 'node:crypto';
import { MAX_CLASSIFICATION_RULES_PER_TENANT } from '@lc/core';
import type {
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
  Rfq,
  RfqRepository,
  SentMail,
  SentMailRepository,
  SentMailStatus,
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
  /** Seeds the inbox list directly; the processor's insert path is not part of the API. Detail fields default to empty. */
  addEmail(
    email: Omit<EmailSummary, 'classification'> &
      Partial<Pick<EmailSummary, 'classification'>> &
      Partial<Omit<EmailDetail, keyof EmailSummary>> & { mailboxId: string; tenantId: string },
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
  const emails: (EmailDetail & { mailboxId: string; tenantId: string })[] = [];
  const sentMails: (SentMail & { mailboxId: string; tenantId: string })[] = [];
  const rfqs: (Rfq & { mailboxId: string; tenantId: string })[] = [];

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
        });
        return credentials;
      },
    },
    emailReadRepository: {
      async listEmails({ mailboxId, tenantId }, { limit, gmailLabel, before }) {
        return emails
          .filter((email) => email.mailboxId === mailboxId && email.tenantId === tenantId)
          .filter((email) => !gmailLabel || email.gmailLabel === gmailLabel)
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
        return sentMails.filter(
          (candidate) =>
            candidate.rfqId === rfqId &&
            candidate.mailboxId === scope.mailboxId &&
            candidate.tenantId === scope.tenantId,
        );
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
    rfqRepository: {
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
      async updateSignature(scope, signature) {
        const connection = findInTenant(scope);
        if (connection) connection.signature = signature;
      },
    },
  };
}
