import type { ScheduledEvent } from 'aws-lambda';
import { toGmailApiError } from '@lc/core';
import type {
  EncryptionUtil,
  GmailMessages,
  GoogleOAuthClientCredentials,
  MailboxConnectionRepository,
  SentMailRepository,
  StaleSendingMail,
  TenantRepository,
} from '@lc/core';
import { log } from '../structuredLog.js';

export interface SentMailSweeperDependencies {
  sentMailRepository: SentMailRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  tenantRepository: TenantRepository;
  encryptionUtil: EncryptionUtil;
  gmailMessages: GmailMessages;
  /** Injected so tests can pin "now"; the handler passes the clock. */
  now?: () => Date;
}

export type SentMailSweeper = (
  event: Pick<ScheduledEvent, 'time'>,
) => Promise<SentMailSweepSummary>;

export interface SentMailSweepSummary {
  checked: number;
  confirmedSent: number;
  markedFailed: number;
  leftSending: number;
  markedNeedsReconnect: number;
  failed: number;
}

/**
 * A row is `sending` while messages.send is in flight; one still there after this long was left
 * by a timeout, a 5xx or a crash, and Gmail is asked whether it kept the mail.
 */
export const STALE_SENDING_AFTER_MS = 10 * 60 * 1000;
/**
 * Gmail shows a sent mail in SENT within seconds; one still missing after this long never went
 * out. The row becomes `failed` so the RFQ send can retry it and a reply can be tried again.
 */
export const GIVE_UP_SENDING_AFTER_MS = 60 * 60 * 1000;
/** Rows per tick; ticks come every 15 minutes (infra), so a backlog drains in a few ticks. */
export const MAX_ROWS_PER_SWEEP = 200;
/** errorCode written when the give-up window passes with no SENT copy. */
export const SEND_UNCONFIRMED_ERROR_CODE = 'send_unconfirmed';
/**
 * errorCode written when the give-up window passes and Gmail could not even be asked (tenant lost
 * its Google client, token undecryptable, Gmail erroring). The mail may or may not have gone out;
 * a retry should check the Sent folder first. Without this a poison row would fail every tick.
 */
export const SEND_UNVERIFIABLE_ERROR_CODE = 'send_unverifiable';

type RowOutcome =
  'confirmed_sent' | 'marked_failed' | 'left_sending' | 'needs_reconnect' | 'failed';

/**
 * One tick = resolve every stale `sending` row, one at a time. Found in SENT -> `sent` with Gmail's
 * ids; not found and past the give-up window -> `failed`; not found but younger -> left for the
 * next tick. A failure on one row never stops the others; it makes the run throw at the end so
 * EventBridge's async retry re-runs the tick, until the row is past the give-up window, when it is
 * marked `failed` unverified instead. A mailbox whose token is dead is flagged and its remaining
 * rows skipped this tick (every call would fail the same way).
 */
export function createSentMailSweeper(dependencies: SentMailSweeperDependencies): SentMailSweeper {
  const {
    sentMailRepository,
    mailboxConnectionRepository,
    tenantRepository,
    encryptionUtil,
    gmailMessages,
    now = () => new Date(),
  } = dependencies;

  async function findTenantCredentials(
    tenantId: string,
    cache: Map<string, GoogleOAuthClientCredentials | undefined>,
  ): Promise<GoogleOAuthClientCredentials | undefined> {
    if (cache.has(tenantId)) return cache.get(tenantId);
    const tenantClient = await tenantRepository.findTenantGoogleClient(tenantId);
    const credentials = tenantClient
      ? {
          clientId: tenantClient.clientId,
          clientSecret: encryptionUtil.decryptSecret(tenantClient.encryptedClientSecret),
        }
      : undefined;
    cache.set(tenantId, credentials);
    return credentials;
  }

  async function resolveRow(
    row: StaleSendingMail,
    tickTime: Date,
    tenantCredentials: Map<string, GoogleOAuthClientCredentials | undefined>,
    mailboxesWithDeadToken: Set<string>,
  ): Promise<RowOutcome> {
    const scope = { mailboxId: row.mailboxId, tenantId: row.tenantId };
    const context = {
      ...scope,
      sentMailId: row.sentMailId,
      rfcMessageId: row.rfcMessageId,
      sendingSince: row.updatedAt.toISOString(),
    };
    const ageMs = tickTime.getTime() - row.updatedAt.getTime();

    /**
     * Gmail could not be asked. Young row: hand back `youngOutcome` (retry the tick, or wait for a
     * reconnect). Past the give-up window: mark it failed anyway, otherwise a poison row fails
     * every tick forever and, with the batch cap, starves rows of healthy mailboxes.
     */
    async function giveUpOr(
      youngOutcome: 'failed' | 'left_sending',
      reason: string,
      detail: Record<string, unknown>,
    ): Promise<RowOutcome> {
      if (ageMs < GIVE_UP_SENDING_AFTER_MS) {
        log(youngOutcome === 'failed' ? 'error' : 'warn', `stale sending row left: ${reason}`, {
          ...context,
          ...detail,
        });
        return youngOutcome;
      }
      const { moved } = await sentMailRepository.markFailedByRfcMessageId(
        scope,
        row.rfcMessageId,
        SEND_UNVERIFIABLE_ERROR_CODE,
      );
      log('warn', moved ? `${reason}: row marked failed unverified` : 'row moved meanwhile', {
        ...context,
        ...detail,
        ageMs,
      });
      return 'marked_failed';
    }

    try {
      if (mailboxesWithDeadToken.has(row.mailboxId)) {
        return giveUpOr('left_sending', 'mailbox token dead this tick', {});
      }
      if (row.gmailConnectionStatus !== 'connected' || !row.encryptedRefreshToken) {
        return giveUpOr('left_sending', 'mailbox not connected', {});
      }
      let credentials;
      let refreshToken;
      try {
        credentials = await findTenantCredentials(row.tenantId, tenantCredentials);
        refreshToken = encryptionUtil.decryptSecret(row.encryptedRefreshToken);
      } catch (error) {
        return giveUpOr('failed', 'tenant client or token unreadable', {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (!credentials) return giveUpOr('failed', 'tenant has no Google client', {});
      let sentCopy;
      try {
        sentCopy = await gmailMessages.findSentMessageByRfcMessageId({
          credentials,
          refreshToken,
          rfcMessageId: row.rfcMessageId,
        });
      } catch (error) {
        const gmailError = toGmailApiError(error);
        if (gmailError.code === 'invalid_grant') {
          mailboxesWithDeadToken.add(row.mailboxId);
          await mailboxConnectionRepository.markGmailNeedsReconnect(scope);
          log('warn', 'refresh token dead: mailbox marked needs_reconnect', context);
          return 'needs_reconnect';
        }
        return giveUpOr('failed', 'gmail search for sent copy failed', {
          code: gmailError.code,
          detail: gmailError.message,
        });
      }
      if (sentCopy) {
        const { moved } = await sentMailRepository.markSentByRfcMessageId(
          scope,
          row.rfcMessageId,
          sentCopy,
        );
        log('info', moved ? 'stale sending row confirmed sent' : 'row moved meanwhile', context);
        return 'confirmed_sent';
      }
      if (ageMs < GIVE_UP_SENDING_AFTER_MS) {
        log('info', 'no sent copy yet, asking again next tick', { ...context, ageMs });
        return 'left_sending';
      }
      const { moved } = await sentMailRepository.markFailedByRfcMessageId(
        scope,
        row.rfcMessageId,
        SEND_UNCONFIRMED_ERROR_CODE,
      );
      log('warn', moved ? 'no sent copy: row marked failed' : 'row moved meanwhile', {
        ...context,
        ageMs,
      });
      return 'marked_failed';
    } catch (error) {
      // A repository write failed: this row fails, the others still run.
      log('error', 'stale sending row not resolved', {
        ...context,
        detail: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
  }

  return async (event) => {
    const tickTime = now();
    const staleBefore = new Date(tickTime.getTime() - STALE_SENDING_AFTER_MS);
    const rows = await sentMailRepository.listStaleSending(staleBefore, MAX_ROWS_PER_SWEEP);
    const tenantCredentials = new Map<string, GoogleOAuthClientCredentials | undefined>();
    const mailboxesWithDeadToken = new Set<string>();
    const summary: SentMailSweepSummary = {
      checked: rows.length,
      confirmedSent: 0,
      markedFailed: 0,
      leftSending: 0,
      markedNeedsReconnect: 0,
      failed: 0,
    };
    for (const row of rows) {
      const outcome = await resolveRow(row, tickTime, tenantCredentials, mailboxesWithDeadToken);
      if (outcome === 'confirmed_sent') summary.confirmedSent += 1;
      else if (outcome === 'marked_failed') summary.markedFailed += 1;
      else if (outcome === 'left_sending') summary.leftSending += 1;
      else if (outcome === 'needs_reconnect') summary.markedNeedsReconnect += 1;
      else summary.failed += 1;
    }
    log(summary.failed > 0 ? 'error' : 'info', 'sent mail sweep tick done', {
      tickTime: event.time,
      staleBefore: staleBefore.toISOString(),
      ...summary,
    });
    if (summary.failed > 0) {
      throw new Error(`${summary.failed} of ${summary.checked} stale sending rows not resolved`);
    }
    return summary;
  };
}
