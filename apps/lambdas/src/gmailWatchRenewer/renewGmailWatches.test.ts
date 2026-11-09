import { GmailApiError, createEncryptionUtil } from '@lc/core';
import type {
  GmailWatch,
  MailboxConnectionRepository,
  MailboxForWatchRenewal,
  MailboxScope,
  MailboxSyncRepository,
  TenantRepository,
} from '@lc/core';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WATCH_RENEWAL_WINDOW_MS, createGmailWatchRenewer } from './renewGmailWatches.js';

const encryptionUtil = createEncryptionUtil(randomBytes(32).toString('base64'));
const NOW = new Date('2026-11-13T12:00:00Z');
const RENEWED_EXPIRY = new Date('2026-11-20T12:00:00Z');
const TICK = { time: NOW.toISOString() };

function mailbox(overrides: Partial<MailboxForWatchRenewal> = {}): MailboxForWatchRenewal {
  return {
    mailboxId: 'mailbox-1',
    tenantId: 'tenant-1',
    emailAddress: 'ops@acme.com',
    encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-1'),
    watchExpiresAt: new Date('2026-11-14T11:00:00Z'),
    ...overrides,
  };
}

function createTestRenewer(mailboxes: MailboxForWatchRenewal[]) {
  const state = {
    deadlines: [] as Date[],
    watchCalls: [] as { refreshToken: string; clientId: string; topicName: string }[],
    watchErrorsByToken: {} as Record<string, Error>,
    saved: [] as { scope: MailboxScope; expiresAt: Date }[],
    needsReconnect: [] as string[],
    tenantLookups: 0,
    tenantsWithoutTopic: new Set<string>(),
    tenantLookupError: undefined as Error | undefined,
    saveError: undefined as Error | undefined,
  };
  const mailboxSyncRepository = {
    async findMailboxesWithWatchExpiringBefore(deadline: Date) {
      state.deadlines.push(deadline);
      return mailboxes;
    },
    async saveWatchExpiry(scope: MailboxScope, expiresAt: Date) {
      if (state.saveError) throw state.saveError;
      state.saved.push({ scope, expiresAt });
    },
  } as unknown as MailboxSyncRepository;
  const mailboxConnectionRepository = {
    async markGmailNeedsReconnect(scope: MailboxScope) {
      state.needsReconnect.push(scope.mailboxId);
    },
  } as unknown as MailboxConnectionRepository;
  const tenantRepository = {
    async findTenantGoogleClient(tenantId: string) {
      state.tenantLookups += 1;
      if (state.tenantLookupError) throw state.tenantLookupError;
      return {
        clientId: `client-${tenantId}`,
        encryptedClientSecret: encryptionUtil.encryptSecret(`secret-${tenantId}`),
      };
    },
    async findTenantPubsubPush(tenantId: string) {
      if (state.tenantsWithoutTopic.has(tenantId)) return undefined;
      return {
        topicName: `projects/${tenantId}/topics/gmail`,
        pushServiceAccountEmail: `push@${tenantId}.iam.gserviceaccount.com`,
      };
    },
  } as unknown as TenantRepository;
  const gmailWatch: GmailWatch = {
    async startWatch({ credentials, refreshToken, topicName }) {
      state.watchCalls.push({ refreshToken, clientId: credentials.clientId, topicName });
      const error = state.watchErrorsByToken[refreshToken];
      if (error) throw error;
      return { historyId: 5000n, expiresAt: RENEWED_EXPIRY };
    },
    async stopWatch() {
      throw new Error('not used by the renewer');
    },
  };
  const renew = createGmailWatchRenewer({
    mailboxSyncRepository,
    mailboxConnectionRepository,
    tenantRepository,
    encryptionUtil,
    gmailWatch,
    now: () => NOW,
  });
  return { renew, state };
}

describe('gmailWatchRenewer', () => {
  it('selects watches expiring within the window, renews each with the tenant client and topic, writes only the expiry', async () => {
    const { renew, state } = createTestRenewer([mailbox()]);

    const summary = await renew(TICK);

    expect(state.deadlines).toEqual([new Date(NOW.getTime() + WATCH_RENEWAL_WINDOW_MS)]);
    expect(WATCH_RENEWAL_WINDOW_MS).toBe(36 * 60 * 60 * 1000);
    expect(state.watchCalls).toEqual([
      {
        refreshToken: 'refresh-token-1',
        clientId: 'client-tenant-1',
        topicName: 'projects/tenant-1/topics/gmail',
      },
    ]);
    expect(state.saved).toEqual([
      {
        scope: { mailboxId: 'mailbox-1', tenantId: 'tenant-1' },
        expiresAt: RENEWED_EXPIRY,
      },
    ]);
    expect(summary).toEqual({ checked: 1, renewed: 1, markedNeedsReconnect: 0, failed: 0 });
  });

  it('does nothing when no watch is expiring', async () => {
    const { renew, state } = createTestRenewer([]);

    expect(await renew(TICK)).toEqual({
      checked: 0,
      renewed: 0,
      markedNeedsReconnect: 0,
      failed: 0,
    });
    expect(state.watchCalls).toEqual([]);
  });

  it('looks a tenant up once for all of its mailboxes', async () => {
    const { renew, state } = createTestRenewer([
      mailbox(),
      mailbox({
        mailboxId: 'mailbox-2',
        emailAddress: 'sales@acme.com',
        encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-2'),
      }),
      mailbox({
        mailboxId: 'mailbox-3',
        tenantId: 'tenant-2',
        encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-3'),
      }),
    ]);

    const summary = await renew(TICK);

    expect(summary.renewed).toBe(3);
    expect(state.tenantLookups).toBe(2);
    expect(state.watchCalls.map((call) => call.clientId)).toEqual([
      'client-tenant-1',
      'client-tenant-1',
      'client-tenant-2',
    ]);
  });

  it('marks the mailbox needs_reconnect on invalid_grant and does not count it as a failure', async () => {
    const { renew, state } = createTestRenewer([mailbox()]);
    state.watchErrorsByToken['refresh-token-1'] = new GmailApiError(
      'invalid_grant',
      400,
      'revoked',
    );

    const summary = await renew(TICK);

    expect(state.needsReconnect).toEqual(['mailbox-1']);
    expect(state.saved).toEqual([]);
    expect(summary).toEqual({ checked: 1, renewed: 0, markedNeedsReconnect: 1, failed: 0 });
  });

  it('keeps renewing the other mailboxes after one fails, then throws so EventBridge retries the tick', async () => {
    const { renew, state } = createTestRenewer([
      mailbox(),
      mailbox({
        mailboxId: 'mailbox-2',
        encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-2'),
      }),
    ]);
    state.watchErrorsByToken['refresh-token-1'] = new GmailApiError(
      'request_failed',
      503,
      'Backend Error',
    );

    await expect(renew(TICK)).rejects.toThrow('1 of 2 watch renewals failed');
    expect(state.saved.map((saved) => saved.scope.mailboxId)).toEqual(['mailbox-2']);
    expect(state.needsReconnect).toEqual([]);
  });

  it('fails a mailbox whose tenant has no Pub/Sub topic without calling Gmail', async () => {
    const { renew, state } = createTestRenewer([mailbox()]);
    state.tenantsWithoutTopic.add('tenant-1');

    await expect(renew(TICK)).rejects.toThrow('1 of 1 watch renewals failed');
    expect(state.watchCalls).toEqual([]);
  });

  it('a tenant lookup or repository error fails that mailbox only; the rest are still renewed', async () => {
    const { renew, state } = createTestRenewer([
      mailbox({ tenantId: 'tenant-broken' }),
      mailbox({
        mailboxId: 'mailbox-2',
        encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-2'),
      }),
    ]);
    state.tenantLookupError = new Error('connection reset');

    await expect(renew(TICK)).rejects.toThrow('2 of 2 watch renewals failed');
    expect(state.watchCalls).toEqual([]);

    state.tenantLookupError = undefined;
    state.saveError = new Error('connection reset');
    await expect(renew(TICK)).rejects.toThrow('2 of 2 watch renewals failed');
    expect(state.watchCalls).toHaveLength(2);
    expect(state.saved).toEqual([]);
  });
});
