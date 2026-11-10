import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { GmailApiError, createEncryptionUtil } from '@lc/core';
import type {
  ClassificationLabel,
  ClassificationRuleRepository,
  ClassifierOutcome,
  EmailClassification,
  EmailClassifier,
  EmailIngestRepository,
  EmailToClassify,
  GmailMessages,
  GmailRawMessage,
  MailboxConnectionRepository,
  MailboxForProcessing,
  MailboxSyncRepository,
  NewEmail,
  ClassificationRule,
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
const ruleState = { enabled: true, createdAt: new Date('2026-11-01T00:00:00Z') };
const LLM_CLASSIFIED: ClassifierOutcome = {
  outcome: 'classified',
  classification: {
    source: 'llm',
    label: 'rate_card',
    confidence: 0.91,
    llmModel: 'gpt-test',
    promptVersion: 'classify-email-v1',
  },
};

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

/** A Gmail-style reply: the new line on top, the sender's name, then the quoted earlier message. */
const REPLY_RAW = Buffer.from(
  [
    'From: Ravi Kumar <ravi@acme.com>',
    'To: ops@desk.com',
    'Subject: Re: RFQ Mumbai to Rotterdam',
    'Date: Tue, 10 Nov 2026 10:00:00 +0530',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please share the BL draft.',
    '',
    'Ravi',
    '',
    'On Mon, 9 Nov 2026 at 10:00, Ops Desk <ops@desk.com> wrote:',
    '> Need a quote for 2 x 40ft.',
    '> Rates attached below.',
  ].join('\r\n'),
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

function createTestProcessor(
  overrides: { mailbox?: Partial<MailboxForProcessing> | null; withClassifier?: boolean } = {},
) {
  const mailbox: MailboxForProcessing = {
    gmailConnectionStatus: 'connected',
    encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-1'),
    ...overrides.mailbox,
  };
  const state = {
    storedIds: new Set<string>(),
    storedThreadIds: new Set<string>(),
    threadLabels: {} as Record<string, ClassificationLabel[]>,
    /** The mailbox already holds the thread, its earlier messages carrying these current labels. */
    storeThread(gmailThreadId: string, currentLabels: ClassificationLabel[]) {
      state.storedThreadIds.add(gmailThreadId);
      state.threadLabels[gmailThreadId] = currentLabels;
    },
    threadLookups: [] as { gmailThreadId: string; receivedBefore: Date }[],
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
    insertedClassifications: [] as (EmailClassification | undefined)[],
    classificationRules: [] as ClassificationRule[],
    ruleLookups: [] as string[],
    classifyCalls: [] as EmailToClassify[],
    classifyOutcome: LLM_CLASSIFIED as ClassifierOutcome,
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
  const emailIngestRepository: EmailIngestRepository = {
    async emailExists(_scope, gmailMessageId) {
      return state.storedIds.has(gmailMessageId);
    },
    async findThreadContext(_scope, gmailThreadId, receivedBefore) {
      state.threadLookups.push({ gmailThreadId, receivedBefore });
      return {
        hasStoredEmail: state.storedThreadIds.has(gmailThreadId),
        currentLabels: state.threadLabels[gmailThreadId] ?? [],
      };
    },
    async insertEmailIfAbsent(newEmail, attachments, classification) {
      state.inserted.push(newEmail);
      state.insertedAttachments.push(attachments);
      state.insertedClassifications.push(classification);
      return state.insertResult;
    },
  };
  const emailClassifier: EmailClassifier = {
    async classify(email) {
      state.classifyCalls.push(email);
      return state.classifyOutcome;
    },
  };
  const classificationRuleRepository: ClassificationRuleRepository = {
    async listEnabledRules(tenantId) {
      state.ruleLookups.push(tenantId);
      return state.classificationRules;
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
    emailIngestRepository,
    classificationRuleRepository,
    emailClassifier: overrides.withClassifier ? emailClassifier : undefined,
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

  it('classifies inbound mail by the first tenant rule matching the sender, inside the insert', async () => {
    const { process, state } = createTestProcessor();
    state.classificationRules = [
      {
        id: 'rule-domain',
        priority: 20,
        senderPattern: 'acme.com',
        label: 'general',
        ...ruleState,
      },
      {
        id: 'rule-address',
        priority: 10,
        senderPattern: 'ravi@acme.com',
        label: 'customer_request',
        ...ruleState,
      },
    ];

    await process(sqsEvent(queueMessage));

    expect(state.ruleLookups).toEqual(['tenant-1']);
    expect(state.insertedClassifications).toEqual([
      { source: 'rule', ruleId: 'rule-address', label: 'customer_request' },
    ]);
  });

  it('inserts without a classification when no rule matches and no classifier is configured', async () => {
    const { process, state } = createTestProcessor();
    state.classificationRules = [
      {
        id: 'rule-other',
        priority: 1,
        senderPattern: 'other.com',
        label: 'rate_card',
        ...ruleState,
      },
    ];

    await process(sqsEvent(queueMessage));

    expect(state.insertedClassifications).toEqual([undefined]);
  });

  it('never runs rules for a SENT message', async () => {
    const { process, state } = createTestProcessor();
    state.fetchResult = { ...state.fetchResult, labelIds: ['SENT'] };
    state.classificationRules = [
      {
        id: 'rule-domain',
        priority: 1,
        senderPattern: 'acme.com',
        label: 'customer_request',
        ...ruleState,
      },
    ];

    await process(sqsEvent(queueMessage));

    expect(state.ruleLookups).toEqual([]);
    expect(state.insertedClassifications).toEqual([undefined]);
  });

  it('asks the model when no rule matches and stores its label with model and prompt version', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.fetchResult = { ...state.fetchResult, raw: new Uint8Array(MULTIPART_RAW) };

    expect(await process(sqsEvent(queueMessage))).toEqual({ batchItemFailures: [] });

    expect(state.classifyCalls).toHaveLength(1);
    expect(state.classifyCalls[0]).toMatchObject({
      senderName: 'Ravi Kumar',
      senderEmail: 'ravi@acme.com',
      subject: 'Rate card',
    });
    expect(state.classifyCalls[0]?.attachments.map((attachment) => attachment.fileName)).toEqual([
      'logo.png',
      'rate-card.pdf',
    ]);
    expect(state.insertedClassifications).toEqual([LLM_CLASSIFIED.classification]);
  });

  it('stores and classifies only what the sender typed when the thread is already in the mailbox', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.fetchResult = { ...state.fetchResult, raw: new Uint8Array(REPLY_RAW) };
    state.storedThreadIds.add('thread-1');

    await process(sqsEvent(queueMessage));

    // The lookup is bounded by the mail's own Date header, so a later-arriving earlier mail cannot inherit from it.
    expect(state.threadLookups).toEqual([
      { gmailThreadId: 'thread-1', receivedBefore: new Date('2026-11-10T04:30:00Z') },
    ]);
    expect(state.inserted[0]?.bodyText).toBe('Please share the BL draft.\n\nRavi');
    expect(state.classifyCalls[0]?.bodyText).toBe('Please share the BL draft.\n\nRavi');
  });

  it('keeps the quoted history when the thread is new to the mailbox', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.fetchResult = { ...state.fetchResult, raw: new Uint8Array(REPLY_RAW) };

    await process(sqsEvent(queueMessage));

    expect(state.inserted[0]?.bodyText).toContain('Please share the BL draft.');
    expect(state.inserted[0]?.bodyText).toContain('Need a quote for 2 x 40ft.');
    expect(state.classifyCalls[0]?.bodyText).toContain('Need a quote for 2 x 40ft.');
  });

  it('strips a SENT reply the same way, since the desk quotes the customer too', async () => {
    const { process, state } = createTestProcessor();
    state.fetchResult = {
      ...state.fetchResult,
      raw: new Uint8Array(REPLY_RAW),
      labelIds: ['SENT'],
    };
    state.storedThreadIds.add('thread-1');

    await process(sqsEvent(queueMessage));

    expect(state.threadLookups.map((lookup) => lookup.gmailThreadId)).toEqual(['thread-1']);
    expect(state.inserted[0]?.bodyText).toBe('Please share the BL draft.\n\nRavi');
  });

  it('bounds the thread lookup by internalDate when the mail has no Date header', async () => {
    const { process, state } = createTestProcessor();
    state.fetchResult = { ...state.fetchResult, raw: new Uint8Array(DATELESS_RAW) };

    await process(sqsEvent(queueMessage));

    expect(state.threadLookups[0]?.receivedBefore).toEqual(new Date('2026-11-09T04:31:00Z'));
  });

  it('labels a later inbound mail customer_reply when the thread already holds a customer_request, before rules and model', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.storeThread('thread-1', ['customer_request', 'general']);
    state.classificationRules = [
      { id: 'rule-domain', priority: 1, senderPattern: 'acme.com', label: 'general', ...ruleState },
    ];

    await process(sqsEvent(queueMessage));

    expect(state.insertedClassifications).toEqual([{ source: 'thread', label: 'customer_reply' }]);
    expect(state.ruleLookups).toEqual([]);
    expect(state.classifyCalls).toEqual([]);
  });

  it('keeps labelling customer_reply as the thread goes on', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.storeThread('thread-1', ['customer_request', 'customer_reply']);

    await process(sqsEvent(queueMessage));

    expect(state.insertedClassifications).toEqual([{ source: 'thread', label: 'customer_reply' }]);
  });

  it('stops deriving once the request itself is no longer labelled customer_request, even if earlier replies are', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.storeThread('thread-1', ['general', 'customer_reply']);

    await process(sqsEvent(queueMessage));

    expect(state.classifyCalls).toHaveLength(1);
    expect(state.insertedClassifications).toEqual([LLM_CLASSIFIED.classification]);
  });

  it('does not derive customer_reply from a thread labelled only general or rate_card', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.storeThread('thread-1', ['general', 'rate_card']);

    await process(sqsEvent(queueMessage));

    expect(state.classifyCalls).toHaveLength(1);
    expect(state.insertedClassifications).toEqual([LLM_CLASSIFIED.classification]);
  });

  it('never derives customer_reply for a SENT message', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.fetchResult = { ...state.fetchResult, labelIds: ['SENT'] };
    state.storeThread('thread-1', ['customer_request']);

    await process(sqsEvent(queueMessage));

    expect(state.insertedClassifications).toEqual([undefined]);
  });

  it('does not ask the model when a rule matched', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.classificationRules = [
      { id: 'rule-domain', priority: 1, senderPattern: 'acme.com', label: 'general', ...ruleState },
    ];

    await process(sqsEvent(queueMessage));

    expect(state.classifyCalls).toEqual([]);
    expect(state.insertedClassifications).toEqual([
      { source: 'rule', ruleId: 'rule-domain', label: 'general' },
    ]);
  });

  it('never asks the model about a SENT message', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.fetchResult = { ...state.fetchResult, labelIds: ['SENT'] };

    await process(sqsEvent(queueMessage));

    expect(state.classifyCalls).toEqual([]);
    expect(state.insertedClassifications).toEqual([undefined]);
  });

  it('returns the record to the queue when the model is unavailable, without inserting', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.classifyOutcome = { outcome: 'retry', detail: '429 rate limited' };

    expect(await process(sqsEvent(queueMessage))).toEqual({
      batchItemFailures: [{ itemIdentifier: 'sqs-1' }],
    });
    expect(state.inserted).toEqual([]);
  });

  it('stores the mail unclassified instead of dead-lettering it when the model is unavailable on the last delivery', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.classifyOutcome = { outcome: 'retry', detail: '503 overloaded' };
    const event = sqsEvent(queueMessage);
    event.Records[0]!.attributes = { ApproximateReceiveCount: '3' } as SQSRecord['attributes'];

    expect(await process(event)).toEqual({ batchItemFailures: [] });
    expect(state.inserted).toHaveLength(1);
    expect(state.insertedClassifications).toEqual([undefined]);
  });

  it('still retries on the second delivery', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.classifyOutcome = { outcome: 'retry', detail: '503 overloaded' };
    const event = sqsEvent(queueMessage);
    event.Records[0]!.attributes = { ApproximateReceiveCount: '2' } as SQSRecord['attributes'];

    expect(await process(event)).toEqual({ batchItemFailures: [{ itemIdentifier: 'sqs-1' }] });
    expect(state.inserted).toEqual([]);
  });

  it('stores the mail unclassified when the model rejects the request', async () => {
    const { process, state } = createTestProcessor({ withClassifier: true });
    state.classifyOutcome = { outcome: 'failed', detail: '400 invalid schema' };

    expect(await process(sqsEvent(queueMessage))).toEqual({ batchItemFailures: [] });
    expect(state.inserted).toHaveLength(1);
    expect(state.insertedClassifications).toEqual([undefined]);
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
