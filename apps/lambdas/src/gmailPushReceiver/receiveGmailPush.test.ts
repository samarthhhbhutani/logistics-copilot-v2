import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { GmailApiError, createEncryptionUtil } from '@lc/core';
import type {
  GmailHistory,
  MailboxConnectionRepository,
  MailboxForPush,
  MailboxSyncRepository,
  TenantRepository,
} from '@lc/core';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GmailMessageIdPublisher } from './gmailMessageIdPublisher.js';
import { createGmailPushReceiver } from './receiveGmailPush.js';
import type { PushTokenVerifier } from './pushTokenVerifier.js';

const encryptionUtil = createEncryptionUtil(randomBytes(32).toString('base64'));
const PUSH_SERVICE_ACCOUNT = 'logistics-copilot-push@acme-mail.iam.gserviceaccount.com';
const RECEIVER_HOST = 'abc123.lambda-url.ap-south-1.on.aws';

function pushEvent(input: {
  emailAddress?: string;
  historyId?: number;
  bearer?: string | null;
  body?: string;
}): APIGatewayProxyEventV2 {
  const data = Buffer.from(
    JSON.stringify({
      emailAddress: input.emailAddress ?? 'ops@acme.com',
      historyId: input.historyId ?? 2000,
    }),
  ).toString('base64');
  const headers: Record<string, string> = {};
  if (input.bearer !== null) headers.authorization = `Bearer ${input.bearer ?? 'valid-token'}`;
  return {
    headers,
    body: input.body ?? JSON.stringify({ message: { data, messageId: 'pubsub-1' } }),
    isBase64Encoded: false,
    requestContext: { domainName: RECEIVER_HOST, http: { method: 'POST' } },
    rawPath: '/',
  } as unknown as APIGatewayProxyEventV2;
}

function createTestReceiver(overrides: { mailbox?: Partial<MailboxForPush> | null } = {}) {
  const mailbox: MailboxForPush = {
    mailboxId: 'mailbox-1',
    tenantId: 'tenant-1',
    gmailConnectionStatus: 'connected',
    encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-1'),
    lastHistoryId: 1000n,
    pushServiceAccountEmail: PUSH_SERVICE_ACCOUNT,
    ...overrides.mailbox,
  };
  const state = {
    cursor: mailbox.lastHistoryId,
    needsReconnect: false,
    enqueued: [] as { scope: { mailboxId: string; tenantId: string }; ids: string[] }[],
    historyCalls: [] as { refreshToken: string; startHistoryId: bigint; clientId: string }[],
    historyResult: { messageIds: ['gm-1', 'gm-2'], historyId: 2000n },
    historyError: undefined as GmailApiError | undefined,
    publishError: undefined as Error | undefined,
    verifiedEmail: PUSH_SERVICE_ACCOUNT as string | undefined,
    verifyCalls: [] as { authorizationHeader: string | undefined; expectedAudienceHost: string }[],
  };
  const pushTokenVerifier: PushTokenVerifier = {
    async verify(input) {
      state.verifyCalls.push(input);
      if (!input.authorizationHeader?.startsWith('Bearer ') || !state.verifiedEmail)
        return undefined;
      return { email: state.verifiedEmail };
    },
  };
  const mailboxSyncRepository: MailboxSyncRepository = {
    async findMailboxForPush(emailAddress) {
      if (overrides.mailbox === null || emailAddress !== 'ops@acme.com') return undefined;
      return { ...mailbox, lastHistoryId: state.cursor };
    },
    async advanceHistoryCursor(_scope, historyId) {
      if (state.cursor !== null && state.cursor >= historyId) return false;
      state.cursor = historyId;
      return true;
    },
    async resetHistoryCursor(_scope, historyId) {
      state.cursor = historyId;
    },
  };
  const mailboxConnectionRepository = {
    async markGmailNeedsReconnect() {
      state.needsReconnect = true;
    },
  } as unknown as MailboxConnectionRepository;
  const tenantRepository = {
    async findTenantGoogleClient() {
      return {
        clientId: 'client-id-1',
        encryptedClientSecret: encryptionUtil.encryptSecret('client-secret-1'),
      };
    },
  } as unknown as TenantRepository;
  const gmailHistory: GmailHistory = {
    async listMessagesAddedSince({ credentials, refreshToken, startHistoryId }) {
      state.historyCalls.push({ refreshToken, startHistoryId, clientId: credentials.clientId });
      if (state.historyError) throw state.historyError;
      return state.historyResult;
    },
  };
  const gmailMessageIdPublisher: GmailMessageIdPublisher = {
    async publish(scope, ids) {
      if (state.publishError) throw state.publishError;
      state.enqueued.push({ scope, ids });
    },
  };
  const receive = createGmailPushReceiver({
    pushTokenVerifier,
    mailboxSyncRepository,
    mailboxConnectionRepository,
    tenantRepository,
    encryptionUtil,
    gmailHistory,
    gmailMessageIdPublisher,
  });
  return { receive, state };
}

describe('gmailPushReceiver', () => {
  it('lists history from the stored cursor with the decrypted token, enqueues the ids, then advances the cursor', async () => {
    const { receive, state } = createTestReceiver();

    const response = await receive(pushEvent({ historyId: 2000 }));

    expect(response).toEqual({ statusCode: 204 });
    expect(state.verifyCalls).toEqual([
      { authorizationHeader: 'Bearer valid-token', expectedAudienceHost: RECEIVER_HOST },
    ]);
    expect(state.historyCalls).toEqual([
      { refreshToken: 'refresh-token-1', startHistoryId: 1000n, clientId: 'client-id-1' },
    ]);
    expect(state.enqueued).toEqual([
      { scope: { mailboxId: 'mailbox-1', tenantId: 'tenant-1' }, ids: ['gm-1', 'gm-2'] },
    ]);
    expect(state.cursor).toBe(2000n);
  });

  it('401 without a valid Google token, before touching the database', async () => {
    const { receive, state } = createTestReceiver();
    expect(await receive(pushEvent({ bearer: null }))).toEqual({ statusCode: 401 });
    state.verifiedEmail = undefined;
    expect(await receive(pushEvent({}))).toEqual({ statusCode: 401 });
    expect(state.historyCalls).toEqual([]);
  });

  it('400 for a body that is not a Gmail notification', async () => {
    const { receive } = createTestReceiver();
    expect(await receive(pushEvent({ body: '{"message":{}}' }))).toEqual({ statusCode: 400 });
  });

  it('403 when the token identity is not the tenant push service account', async () => {
    const { receive, state } = createTestReceiver();
    state.verifiedEmail = 'someone-else@other-project.iam.gserviceaccount.com';
    expect(await receive(pushEvent({}))).toEqual({ statusCode: 403 });
    expect(state.historyCalls).toEqual([]);
  });

  it('204 and nothing else for an unknown address or a mailbox that is not connected', async () => {
    const unknown = createTestReceiver({ mailbox: null });
    expect(await unknown.receive(pushEvent({}))).toEqual({ statusCode: 204 });
    const reconnect = createTestReceiver({ mailbox: { gmailConnectionStatus: 'needs_reconnect' } });
    expect(await reconnect.receive(pushEvent({}))).toEqual({ statusCode: 204 });
    expect(reconnect.state.historyCalls).toEqual([]);
  });

  it('skips a push the cursor already covers (duplicate or out-of-order delivery)', async () => {
    const { receive, state } = createTestReceiver({ mailbox: { lastHistoryId: 2000n } });
    expect(await receive(pushEvent({ historyId: 1500 }))).toEqual({ statusCode: 204 });
    expect(state.historyCalls).toEqual([]);
    expect(state.cursor).toBe(2000n);
  });

  it('invalid_grant marks the mailbox needs_reconnect and leaves the cursor', async () => {
    const { receive, state } = createTestReceiver();
    state.historyError = new GmailApiError(
      'invalid_grant',
      400,
      'Token has been expired or revoked.',
    );
    expect(await receive(pushEvent({}))).toEqual({ statusCode: 204 });
    expect(state.needsReconnect).toBe(true);
    expect(state.cursor).toBe(1000n);
    expect(state.enqueued).toEqual([]);
  });

  it('a 404 history gap restarts the cursor at the push, enqueuing nothing', async () => {
    const { receive, state } = createTestReceiver();
    state.historyError = new GmailApiError('not_found', 404, 'Requested entity was not found.');
    expect(await receive(pushEvent({ historyId: 2000 }))).toEqual({ statusCode: 204 });
    expect(state.cursor).toBe(2000n);
    expect(state.enqueued).toEqual([]);
  });

  it('any other Gmail failure answers 204 and leaves the cursor for the next push', async () => {
    const { receive, state } = createTestReceiver();
    state.historyError = new GmailApiError('request_failed', 503, 'Backend Error');
    expect(await receive(pushEvent({}))).toEqual({ statusCode: 204 });
    expect(state.cursor).toBe(1000n);
  });

  it('a publish failure leaves the cursor so the next push replays the ids', async () => {
    const { receive, state } = createTestReceiver();
    state.publishError = new Error('SendMessageBatch failed');
    expect(await receive(pushEvent({}))).toEqual({ statusCode: 204 });
    expect(state.cursor).toBe(1000n);
  });

  it('no new INBOX or SENT mail still advances the cursor without touching the queue', async () => {
    const { receive, state } = createTestReceiver();
    state.historyResult = { messageIds: [], historyId: 2000n };
    expect(await receive(pushEvent({}))).toEqual({ statusCode: 204 });
    expect(state.enqueued).toEqual([]);
    expect(state.cursor).toBe(2000n);
  });
});
