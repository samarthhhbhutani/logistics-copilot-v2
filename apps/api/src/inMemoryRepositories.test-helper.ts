import { randomUUID } from 'node:crypto';
import { MAX_CLASSIFICATION_RULES_PER_TENANT } from '@lc/core';
import type {
  AttachmentRepository,
  AttachmentSummary,
  ClassificationRule,
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
  emailClassificationRepository: EmailClassificationRepository;
  sentMailRepository: SentMailRepository;
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

  function emailsInScope({ mailboxId, tenantId }: { mailboxId: string; tenantId: string }) {
    return emails.filter((email) => email.mailboxId === mailboxId && email.tenantId === tenantId);
  }
  const attachments: (AttachmentSummary & { tenantId: string })[] = [];
  const classificationRules: (ClassificationRule & { tenantId: string })[] = [];

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
          sentEmailId: null,
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
      markSending: (scope, sentMailId) =>
        moveSentMail(scope, sentMailId, { from: 'pending', to: 'sending' }, {}),
      markSent: (scope, sentMailId, gmailIds) =>
        moveSentMail(
          scope,
          sentMailId,
          { from: 'sending', to: 'sent' },
          { ...gmailIds, errorCode: null },
        ),
      markFailed: (scope, sentMailId, errorCode) =>
        moveSentMail(scope, sentMailId, { from: 'sending', to: 'failed' }, { errorCode }),
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
