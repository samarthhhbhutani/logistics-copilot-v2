import { randomUUID } from 'node:crypto';
import { MAX_CLASSIFICATION_RULES_PER_TENANT } from '@lc/core';
import type {
  AttachmentRepository,
  AttachmentSummary,
  ClassificationRule,
  ClassificationRuleRepository,
  EmailRepository,
  EmailSummary,
  MailboxConnection,
  MailboxConnectionRepository,
  MailboxCredentials,
  MailboxCredentialsRepository,
  TenantGoogleClient,
  TenantPubsubPush,
  TenantRepository,
} from '@lc/core';

/** Test doubles with the same contracts as the Prisma repositories, no database. */
export function createInMemoryRepositories(): {
  tenantRepository: TenantRepository;
  mailboxCredentialsRepository: MailboxCredentialsRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  emailRepository: EmailRepository;
  attachmentRepository: AttachmentRepository;
  classificationRuleRepository: ClassificationRuleRepository;
  /** Seeds the inbox list directly; the processor's insert path is not part of the API. */
  addEmail(email: EmailSummary & { mailboxId: string; tenantId: string }): void;
  /** Seeds a stored file on a seeded email; tenantId is the row's own isolation column. */
  addAttachment(attachment: AttachmentSummary & { tenantId: string }): void;
} {
  const googleClientByTenantId = new Map<string, TenantGoogleClient>();
  const pubsubPushByTenantId = new Map<string, TenantPubsubPush>();
  const credentialsByEmail = new Map<string, MailboxCredentials>();
  const connectionByMailboxId = new Map<string, MailboxConnection>();
  const emails: (EmailSummary & { mailboxId: string; tenantId: string })[] = [];
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
        });
        return credentials;
      },
    },
    emailRepository: {
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
      async emailExists() {
        throw new Error('not used by the API');
      },
      async threadHasStoredEmail() {
        throw new Error('not used by the API');
      },
      async insertEmailIfAbsent() {
        throw new Error('not used by the API');
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
    addEmail(email) {
      emails.push(email);
    },
    addAttachment(attachment) {
      attachments.push(attachment);
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
    },
  };
}
