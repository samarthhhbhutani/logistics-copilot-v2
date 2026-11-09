import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { GmailApiError, createEncryptionUtil } from '@lc/core';
import type {
  EmailRepository,
  GmailMessages,
  GmailRawMessage,
  MailboxConnectionRepository,
  MailboxForProcessing,
  MailboxSyncRepository,
  NewEmail,
  StoredAttachment,
  TenantRepository,
} from '@lc/core';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGmailMessageProcessor } from './processGmailMessage.js';
import { attachmentS3Key, sha256Hex } from './attachmentStore.js';
import type { AttachmentStore } from './attachmentStore.js';
import type { RawMailStore } from './rawMailStore.js';

const encryptionUtil = createEncryptionUtil(randomBytes(32).toString('base64'));

const INBOUND_RAW = Buffer.from(
  [
    'From: Ravi Kumar <Ravi@Acme.com>',
    'To: ops@desk.com',
    'Cc: boss@desk.com',
    'Subject: RFQ Mumbai to Rotterdam',
    'Date: Mon, 09 Nov 2026 10:00:00 +0530',
    'Message-ID: <rfq-1@acme.com>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Need a quote for 2 x 40ft.',
  ].join('\r\n'),
);

const DATELESS_RAW = Buffer.from(
  ['To: vendor@sea.com', 'Subject: Re: RFQ', 'Content-Type: text/plain', '', 'Our offer.'].join(
    '\r\n',
  ),
);

const PDF_BYTES = Buffer.from('%PDF-1.4 fake rate card');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A file attachment plus a cid: image referenced from the HTML body. */
const MULTIPART_RAW = Buffer.from(
  [
    'From: Ravi Kumar <ravi@acme.com>',
    'To: ops@desk.com',
    'Subject: Rate card',
    'Date: Mon, 09 Nov 2026 10:00:00 +0530',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: multipart/related; boundary="inner"',
    '',
    '--inner',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Rates attached.</p><img src="cid:logo@acme.com">',
    '--inner',
    'Content-Type: image/png',
    'Content-ID: <logo@acme.com>',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    PNG_BYTES.toString('base64'),
    '--inner--',
    '--outer',
    'Content-Type: application/pdf; name="rate-card.pdf"',
    'Content-Disposition: attachment; filename="rate-card.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    PDF_BYTES.toString('base64'),
    '--outer--',
    '',
  ].join('\r\n'),
);

function sqsEvent(...bodies: (string | object)[]): SQSEvent {
  return {
    Records: bodies.map(
      (body, index) =>
        ({
          messageId: `sqs-${index + 1}`,
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }) as SQSRecord,
    ),
  };
}

const queueMessage = { tenantId: 'tenant-1', mailboxId: 'mailbox-1', gmailMessageId: 'gm-1' };

function createTestProcessor(overrides: { mailbox?: Partial<MailboxForProcessing> | null } = {}) {
  const mailbox: MailboxForProcessing = {
    gmailConnectionStatus: 'connected',
    encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-1'),
    ...overrides.mailbox,
  };
  const state = {
    storedIds: new Set<string>(),
    inserted: [] as NewEmail[],
    insertResult: true,
    needsReconnect: false,
    fetchCalls: [] as { refreshToken: string; clientId: string; gmailMessageId: string }[],
    fetchResult: {
      raw: new Uint8Array(INBOUND_RAW),
      threadId: 'thread-1',
      labelIds: ['INBOX', 'UNREAD'],
      internalDate: new Date('2026-11-09T04:31:00Z'),
      snippet: 'Need a quote for 2 x 40ft.',
    } as GmailRawMessage,
    fetchError: undefined as Error | undefined,
    fetchErrorsById: {} as Record<string, Error>,
    puts: [] as { key: string; bytes: number }[],
    putError: undefined as Error | undefined,
    insertedAttachments: [] as StoredAttachment[][],
    attachmentPuts: [] as { key: string; bytes: number }[],
    attachmentPutError: undefined as Error | undefined,
    tenantHasClient: true,
  };
  const mailboxSyncRepository: MailboxSyncRepository = {
    async findMailboxForPush() {
      throw new Error('not used by the processor');
    },
    async findMailboxForProcessing(scope) {
      if (overrides.mailbox === null) return undefined;
      if (scope.mailboxId !== 'mailbox-1' || scope.tenantId !== 'tenant-1') return undefined;
      return mailbox;
    },
    async findMailboxesWithWatchExpiringBefore() {
      throw new Error('not used here');
    },
    async saveWatchExpiry() {
      throw new Error('not used here');
    },
    async advanceHistoryCursor() {
      throw new Error('not used by the processor');
    },
    async resetHistoryCursor() {
      throw new Error('not used by the processor');
    },
  };
  const mailboxConnectionRepository = {
    async markGmailNeedsReconnect() {
      state.needsReconnect = true;
    },
  } as unknown as MailboxConnectionRepository;
  const tenantRepository = {
    async findTenantGoogleClient() {
      if (!state.tenantHasClient) return undefined;
      return {
        clientId: 'client-id-1',
        encryptedClientSecret: encryptionUtil.encryptSecret('client-secret-1'),
      };
    },
  } as unknown as TenantRepository;
  const gmailMessages: GmailMessages = {
    async getRawMessage({ credentials, refreshToken, gmailMessageId }) {
      state.fetchCalls.push({ refreshToken, clientId: credentials.clientId, gmailMessageId });
      const error = state.fetchError ?? state.fetchErrorsById[gmailMessageId];
      if (error) throw error;
      return state.fetchResult;
    },
  };
  const rawMailStore: RawMailStore = {
    async putRawEmail(scope, gmailMessageId, raw) {
      if (state.putError) throw state.putError;
      const key = `${scope.tenantId}/${scope.mailboxId}/${gmailMessageId}.eml`;
      state.puts.push({ key, bytes: raw.byteLength });
      return key;
    },
  };
  const emailRepository: EmailRepository = {
    async emailExists(_scope, gmailMessageId) {
      return state.storedIds.has(gmailMessageId);
    },
    async insertEmailIfAbsent(newEmail, attachments) {
      state.inserted.push(newEmail);
      state.insertedAttachments.push(attachments);
      return state.insertResult;
    },
  };
  const attachmentStore: AttachmentStore = {
    async uploadAttachmentToS3(scope, attachment) {
      if (state.attachmentPutError) throw state.attachmentPutError;
      const sha256 = sha256Hex(attachment.content);
      const s3Key = attachmentS3Key(scope.tenantId, sha256);
      state.attachmentPuts.push({ key: s3Key, bytes: attachment.sizeBytes });
      return {
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        sha256,
        s3Key,
        contentId: attachment.contentId,
        isInline: attachment.isInline,
      };
    },
  };
  const process = createGmailMessageProcessor({
    mailboxSyncRepository,
    mailboxConnectionRepository,
    tenantRepository,
    encryptionUtil,
    gmailMessages,
    rawMailStore,
    attachmentStore,
    emailRepository,
  });
  return { process, state };
}

describe('emailProcessor', () => {
  it('fetches with the decrypted token, stores the .eml, parses, inserts the row and acks', async () => {
    const { process, state } = createTestProcessor();

    const response = await process(sqsEvent(queueMessage));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(state.fetchCalls).toEqual([
      { refreshToken: 'refresh-token-1', clientId: 'client-id-1', gmailMessageId: 'gm-1' },
    ]);
    expect(state.puts).toEqual([{ key: 'tenant-1/mailbox-1/gm-1.eml', bytes: INBOUND_RAW.length }]);
    expect(state.inserted).toEqual([
      {
        tenantId: 'tenant-1',
        mailboxId: 'mailbox-1',
        gmailMessageId: 'gm-1',
        gmailThreadId: 'thread-1',
        gmailLabel: 'inbox',
        rfcMessageId: '<rfq-1@acme.com>',
        senderName: 'Ravi Kumar',
        senderEmail: 'ravi@acme.com',
        toRecipients: [{ name: '', address: 'ops@desk.com' }],
        ccRecipients: [{ name: '', address: 'boss@desk.com' }],
        subject: 'RFQ Mumbai to Rotterdam',
        snippet: 'Need a quote for 2 x 40ft.',
        bodyText: 'Need a quote for 2 x 40ft.',
        bodyHtml: undefined,
        rawEmailS3Key: 'tenant-1/mailbox-1/gm-1.eml',
        receivedAt: new Date('2026-11-09T04:30:00Z'),
      },
    ]);
  });

  it('labels a SENT message sent and falls back to internalDate and no sender when headers are missing', async () => {
    const { process, state } = createTestProcessor();
    state.fetchResult = {
      ...state.fetchResult,
      raw: new Uint8Array(DATELESS_RAW),
      labelIds: ['SENT'],
      snippet: 'Our offer.',
    };

    await process(sqsEvent(queueMessage));

    expect(state.inserted[0]).toMatchObject({
      gmailLabel: 'sent',
      rfcMessageId: undefined,
      senderName: '',
      senderEmail: undefined,
      toRecipients: [{ name: '', address: 'vendor@sea.com' }],
      receivedAt: new Date('2026-11-09T04:31:00Z'),
    });
  });

  it('stores every attachment under the tenant by sha256 and inserts the rows with the email', async () => {
    const { process, state } = createTestProcessor();
    state.fetchResult = { ...state.fetchResult, raw: new Uint8Array(MULTIPART_RAW) };

    expect(await process(sqsEvent(queueMessage))).toEqual({ batchItemFailures: [] });

    const pdfSha256 = sha256Hex(PDF_BYTES);
    const pngSha256 = sha256Hex(PNG_BYTES);
    expect(state.attachmentPuts).toEqual([
      { key: `tenant-1/attachments/${pngSha256}`, bytes: PNG_BYTES.length },
      { key: `tenant-1/attachments/${pdfSha256}`, bytes: PDF_BYTES.length },
    ]);
    expect(state.insertedAttachments).toEqual([
      [
        {
          fileName: 'logo.png',
          contentType: 'image/png',
          sizeBytes: PNG_BYTES.length,
          sha256: pngSha256,
          s3Key: `tenant-1/attachments/${pngSha256}`,
          contentId: 'logo@acme.com',
          isInline: true,
        },
        {
          fileName: 'rate-card.pdf',
          contentType: 'application/pdf',
          sizeBytes: PDF_BYTES.length,
          sha256: pdfSha256,
          s3Key: `tenant-1/attachments/${pdfSha256}`,
          contentId: undefined,
          isInline: false,
        },
      ],
    ]);
    expect(state.inserted[0]).toMatchObject({
      subject: 'Rate card',
      bodyHtml: expect.stringContaining('cid:logo'),
    });
  });

  it('passes an empty attachment list for a plain text mail', async () => {
    const { process, state } = createTestProcessor();

    await process(sqsEvent(queueMessage));

    expect(state.attachmentPuts).toEqual([]);
    expect(state.insertedAttachments).toEqual([[]]);
  });

  it('returns the record to the queue when S3 refuses an attachment, without inserting', async () => {
    const { process, state } = createTestProcessor();
    state.fetchResult = { ...state.fetchResult, raw: new Uint8Array(MULTIPART_RAW) };
    state.attachmentPutError = new Error('SlowDown');

    expect(await process(sqsEvent(queueMessage))).toEqual({
      batchItemFailures: [{ itemIdentifier: 'sqs-1' }],
    });
    expect(state.inserted).toEqual([]);
  });

  it('acks an id that is already stored without calling Gmail', async () => {
    const { process, state } = createTestProcessor();
    state.storedIds.add('gm-1');

    expect(await process(sqsEvent(queueMessage))).toEqual({ batchItemFailures: [] });
    expect(state.fetchCalls).toEqual([]);
    expect(state.inserted).toEqual([]);
  });

  it('acks when a concurrent run inserted first (insert reports no row)', async () => {
    const { process, state } = createTestProcessor();
    state.insertResult = false;

    expect(await process(sqsEvent(queueMessage))).toEqual({ batchItemFailures: [] });
    expect(state.puts).toHaveLength(1);
  });

  it('marks the mailbox needs_reconnect and acks on invalid_grant', async () => {
    const { process, state } = createTestProcessor();
    state.fetchError = new GmailApiError('invalid_grant', 400, 'Token has been revoked');

    expect(await process(sqsEvent(queueMessage))).toEqual({ batchItemFailures: [] });
    expect(state.needsReconnect).toBe(true);
    expect(state.inserted).toEqual([]);
  });

  it('acks a message Gmail no longer has', async () => {
    const { process, state } = createTestProcessor();
    state.fetchError = new GmailApiError('not_found', 404, 'Requested entity was not found.');

    expect(await process(sqsEvent(queueMessage))).toEqual({ batchItemFailures: [] });
    expect(state.needsReconnect).toBe(false);
    expect(state.puts).toEqual([]);
  });

  it.each([
    ['rate limited', new GmailApiError('rate_limited', 429, 'User-rate limit exceeded')],
    ['a Gmail outage', new GmailApiError('request_failed', 503, 'Backend Error')],
    ['an unknown error', new Error('socket hang up')],
  ])('returns the record to the queue when the fetch hits %s', async (_name, error) => {
    const { process, state } = createTestProcessor();
    state.fetchError = error;

    expect(await process(sqsEvent(queueMessage))).toEqual({
      batchItemFailures: [{ itemIdentifier: 'sqs-1' }],
    });
    expect(state.inserted).toEqual([]);
  });

  it('returns the record to the queue when S3 refuses the .eml, without inserting', async () => {
    const { process, state } = createTestProcessor();
    state.putError = new Error('SlowDown');

    expect(await process(sqsEvent(queueMessage))).toEqual({
      batchItemFailures: [{ itemIdentifier: 'sqs-1' }],
    });
    expect(state.inserted).toEqual([]);
  });

  it.each([
    ['mailbox missing', { mailbox: null }],
    ['mailbox needs reconnect', { mailbox: { gmailConnectionStatus: 'needs_reconnect' as const } }],
    ['mailbox has no token', { mailbox: { encryptedRefreshToken: null } }],
  ])('acks without fetching when the %s', async (_name, overrides) => {
    const { process, state } = createTestProcessor(overrides);

    expect(await process(sqsEvent(queueMessage))).toEqual({ batchItemFailures: [] });
    expect(state.fetchCalls).toEqual([]);
  });

  it('acks without fetching when the tenant has no Google client', async () => {
    const { process, state } = createTestProcessor();
    state.tenantHasClient = false;

    expect(await process(sqsEvent(queueMessage))).toEqual({ batchItemFailures: [] });
    expect(state.fetchCalls).toEqual([]);
  });

  it('acks a record whose body is not a queue message and keeps processing the rest', async () => {
    const { process, state } = createTestProcessor();

    const response = await process(sqsEvent('not json', queueMessage));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(state.inserted).toHaveLength(1);
  });

  it('reports only the failed records of a batch', async () => {
    const { process, state } = createTestProcessor();
    state.storedIds.add('gm-stored');
    state.fetchErrorsById['gm-fail'] = new GmailApiError('request_failed', 500);

    const response = await process(
      sqsEvent(
        { ...queueMessage, gmailMessageId: 'gm-stored' },
        { ...queueMessage, gmailMessageId: 'gm-fail' },
        queueMessage,
      ),
    );

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'sqs-2' }] });
    expect(state.fetchCalls.map((call) => call.gmailMessageId)).toEqual(['gm-fail', 'gm-1']);
    expect(state.inserted.map((email) => email.gmailMessageId)).toEqual(['gm-1']);
  });
});
