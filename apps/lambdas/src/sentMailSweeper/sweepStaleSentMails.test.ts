import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GmailApiError, createEncryptionUtil } from '@lc/core';
import type {
  GmailMessages,
  GmailSentMessageIds,
  MailboxConnectionRepository,
  MailboxScope,
  SentMailRepository,
  StaleSendingMail,
  TenantRepository,
} from '@lc/core';
import {
  GIVE_UP_SENDING_AFTER_MS,
  MAX_ROWS_PER_SWEEP,
  SEND_UNCONFIRMED_ERROR_CODE,
  SEND_UNVERIFIABLE_ERROR_CODE,
  STALE_SENDING_AFTER_MS,
  createSentMailSweeper,
} from './sweepStaleSentMails.js';

const encryptionUtil = createEncryptionUtil(randomBytes(32).toString('base64'));
const NOW = new Date('2026-11-16T12:00:00Z');
const TICK = { time: NOW.toISOString() };
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60 * 1000);

function staleRow(overrides: Partial<StaleSendingMail> = {}): StaleSendingMail {
  const sentMailId = overrides.sentMailId ?? 'sent-mail-1';
  return {
    sentMailId,
    mailboxId: 'mailbox-1',
    tenantId: 'tenant-1',
    rfcMessageId: `<${sentMailId}@acme.com>`,
    updatedAt: minutesAgo(20),
    mailboxEmailAddress: 'ops@acme.com',
    gmailConnectionStatus: 'connected',
    encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-1'),
    ...overrides,
  };
}

function createTestSweeper(rows: StaleSendingMail[]) {
  const state = {
    listCalls: [] as { olderThan: Date; limit: number }[],
    searches: [] as { refreshToken: string; clientId: string; rfcMessageId: string }[],
    sentCopiesByRfcMessageId: {} as Record<string, GmailSentMessageIds>,
    searchErrorsByToken: {} as Record<string, Error>,
    markedSent: [] as { scope: MailboxScope; rfcMessageId: string; ids: GmailSentMessageIds }[],
    markedFailed: [] as { scope: MailboxScope; rfcMessageId: string; errorCode: string }[],
    needsReconnect: [] as string[],
    tenantLookups: 0,
    tenantsWithoutClient: new Set<string>(),
    markSentError: undefined as Error | undefined,
  };
  const sentMailRepository = {
    async listStaleSending(olderThan: Date, limit: number) {
      state.listCalls.push({ olderThan, limit });
      return rows;
    },
    async markSentByRfcMessageId(
      scope: MailboxScope,
      rfcMessageId: string,
      ids: GmailSentMessageIds,
    ) {
      if (state.markSentError) throw state.markSentError;
      state.markedSent.push({ scope, rfcMessageId, ids });
      return { moved: true };
    },
    async markFailedByRfcMessageId(scope: MailboxScope, rfcMessageId: string, errorCode: string) {
      state.markedFailed.push({ scope, rfcMessageId, errorCode });
      return { moved: true };
    },
  } as unknown as SentMailRepository;
  const mailboxConnectionRepository = {
    async markGmailNeedsReconnect(scope: MailboxScope) {
      state.needsReconnect.push(scope.mailboxId);
    },
  } as unknown as MailboxConnectionRepository;
  const tenantRepository = {
    async findTenantGoogleClient(tenantId: string) {
      state.tenantLookups += 1;
      if (state.tenantsWithoutClient.has(tenantId)) return undefined;
      return {
        clientId: `client-${tenantId}`,
        encryptedClientSecret: encryptionUtil.encryptSecret(`secret-${tenantId}`),
      };
    },
  } as unknown as TenantRepository;
  const gmailMessages = {
    async findSentMessageByRfcMessageId({ credentials, refreshToken, rfcMessageId }) {
      state.searches.push({ refreshToken, clientId: credentials.clientId, rfcMessageId });
      const error = state.searchErrorsByToken[refreshToken];
      if (error) throw error;
      return state.sentCopiesByRfcMessageId[rfcMessageId];
    },
  } as GmailMessages;
  const sweeper = createSentMailSweeper({
    sentMailRepository,
    mailboxConnectionRepository,
    tenantRepository,
    encryptionUtil,
    gmailMessages,
    now: () => NOW,
  });
  return { sweeper, state };
}

describe('createSentMailSweeper', () => {
  it('asks for rows stale by the window, confirms the ones Gmail holds in SENT, and leaves younger misses for next tick', async () => {
    const found = staleRow({ sentMailId: 'found' });
    const missingYoung = staleRow({ sentMailId: 'missing-young', updatedAt: minutesAgo(30) });
    const { sweeper, state } = createTestSweeper([found, missingYoung]);
    state.sentCopiesByRfcMessageId[found.rfcMessageId] = {
      gmailMessageId: 'gm-1',
      gmailThreadId: 'gt-1',
    };

    const summary = await sweeper(TICK);

    expect(state.listCalls).toEqual([
      { olderThan: new Date(NOW.getTime() - STALE_SENDING_AFTER_MS), limit: MAX_ROWS_PER_SWEEP },
    ]);
    expect(state.searches.map((search) => search.rfcMessageId)).toEqual([
      found.rfcMessageId,
      missingYoung.rfcMessageId,
    ]);
    expect(state.searches[0]).toMatchObject({
      refreshToken: 'refresh-token-1',
      clientId: 'client-tenant-1',
    });
    expect(state.markedSent).toEqual([
      {
        scope: { mailboxId: 'mailbox-1', tenantId: 'tenant-1' },
        rfcMessageId: found.rfcMessageId,
        ids: { gmailMessageId: 'gm-1', gmailThreadId: 'gt-1' },
      },
    ]);
    expect(state.markedFailed).toEqual([]);
    expect(summary).toEqual({
      checked: 2,
      confirmedSent: 1,
      markedFailed: 0,
      leftSending: 1,
      markedNeedsReconnect: 0,
      failed: 0,
    });
  });

  it('marks a row failed with send_unconfirmed once the give-up window has passed with no SENT copy', async () => {
    const givenUp = staleRow({
      sentMailId: 'given-up',
      updatedAt: new Date(NOW.getTime() - GIVE_UP_SENDING_AFTER_MS),
    });
    const { sweeper, state } = createTestSweeper([givenUp]);

    const summary = await sweeper(TICK);

    expect(state.markedFailed).toEqual([
      {
        scope: { mailboxId: 'mailbox-1', tenantId: 'tenant-1' },
        rfcMessageId: givenUp.rfcMessageId,
        errorCode: SEND_UNCONFIRMED_ERROR_CODE,
      },
    ]);
    expect(summary.markedFailed).toBe(1);
  });

  it('looks each tenant up once and skips rows of a mailbox that is not connected', async () => {
    const rows = [
      staleRow({ sentMailId: 'a' }),
      staleRow({ sentMailId: 'b' }),
      staleRow({
        sentMailId: 'c',
        mailboxId: 'mailbox-2',
        gmailConnectionStatus: 'needs_reconnect',
      }),
    ];
    const { sweeper, state } = createTestSweeper(rows);

    const summary = await sweeper(TICK);

    expect(state.tenantLookups).toBe(1);
    expect(state.searches).toHaveLength(2);
    expect(summary).toMatchObject({ checked: 3, leftSending: 3, failed: 0 });
  });

  it('on a dead refresh token flags the mailbox once and skips its other rows this tick', async () => {
    const rows = [
      staleRow({ sentMailId: 'a' }),
      staleRow({ sentMailId: 'b' }),
      staleRow({
        sentMailId: 'other-mailbox',
        mailboxId: 'mailbox-2',
        encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-2'),
      }),
    ];
    const { sweeper, state } = createTestSweeper(rows);
    state.searchErrorsByToken['refresh-token-1'] = new GmailApiError(
      'invalid_grant',
      400,
      'Token has been expired or revoked.',
    );

    const summary = await sweeper(TICK);

    expect(state.needsReconnect).toEqual(['mailbox-1']);
    expect(state.searches.map((search) => search.refreshToken)).toEqual([
      'refresh-token-1',
      'refresh-token-2',
    ]);
    expect(summary).toMatchObject({
      checked: 3,
      markedNeedsReconnect: 1,
      leftSending: 2,
      failed: 0,
    });
  });

  it('keeps going past a failing row and throws at the end so the tick is retried', async () => {
    const rows = [
      staleRow({ sentMailId: 'no-client', tenantId: 'tenant-2' }),
      staleRow({
        sentMailId: 'search-breaks',
        encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-3'),
      }),
      staleRow({ sentMailId: 'fine' }),
    ];
    const { sweeper, state } = createTestSweeper(rows);
    state.tenantsWithoutClient.add('tenant-2');
    state.searchErrorsByToken['refresh-token-3'] = new GmailApiError(
      'request_failed',
      undefined,
      'socket hang up',
    );
    state.sentCopiesByRfcMessageId[rows[2]!.rfcMessageId] = {
      gmailMessageId: 'gm-3',
      gmailThreadId: 'gt-3',
    };

    await expect(sweeper(TICK)).rejects.toThrow('2 of 3 stale sending rows not resolved');

    expect(state.markedSent.map((marked) => marked.rfcMessageId)).toEqual([rows[2]!.rfcMessageId]);
  });

  it('past the give-up window marks a row it could not verify failed with send_unverifiable instead of failing every tick', async () => {
    const stuckSince = minutesAgo(GIVE_UP_SENDING_AFTER_MS / 60_000 + 1);
    const rows = [
      staleRow({ sentMailId: 'no-client', tenantId: 'tenant-2', updatedAt: stuckSince }),
      staleRow({
        sentMailId: 'search-breaks',
        encryptedRefreshToken: encryptionUtil.encryptSecret('refresh-token-3'),
        updatedAt: stuckSince,
      }),
      staleRow({
        sentMailId: 'garbage-token',
        encryptedRefreshToken: 'not-ciphertext',
        updatedAt: stuckSince,
      }),
      staleRow({
        sentMailId: 'never-reconnected',
        mailboxId: 'mailbox-2',
        gmailConnectionStatus: 'needs_reconnect',
        updatedAt: stuckSince,
      }),
    ];
    const { sweeper, state } = createTestSweeper(rows);
    state.tenantsWithoutClient.add('tenant-2');
    state.searchErrorsByToken['refresh-token-3'] = new GmailApiError(
      'forbidden',
      403,
      'scope gone',
    );

    const summary = await sweeper(TICK);

    expect(summary).toMatchObject({ checked: 4, markedFailed: 4, failed: 0, leftSending: 0 });
    expect(new Set(state.markedFailed.map((marked) => marked.errorCode))).toEqual(
      new Set([SEND_UNVERIFIABLE_ERROR_CODE]),
    );
  });

  it('counts a repository write failure as a failed row rather than crashing the tick', async () => {
    const row = staleRow();
    const { sweeper, state } = createTestSweeper([row]);
    state.sentCopiesByRfcMessageId[row.rfcMessageId] = {
      gmailMessageId: 'gm-1',
      gmailThreadId: 'gt-1',
    };
    state.markSentError = new Error('connection reset');

    await expect(sweeper(TICK)).rejects.toThrow('1 of 1 stale sending rows not resolved');
  });

  it('does nothing on an empty tick', async () => {
    const { sweeper, state } = createTestSweeper([]);

    const summary = await sweeper(TICK);

    expect(summary.checked).toBe(0);
    expect(state.searches).toEqual([]);
  });
});
