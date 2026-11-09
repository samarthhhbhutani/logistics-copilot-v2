import type { ScheduledEvent } from 'aws-lambda';
import { toGmailApiError } from '@lc/core';
import type {
  EncryptionUtil,
  GmailWatch,
  GoogleOAuthClientCredentials,
  MailboxConnectionRepository,
  MailboxForWatchRenewal,
  MailboxSyncRepository,
  TenantRepository,
} from '@lc/core';
import { log } from '../structuredLog.js';

export interface GmailWatchRenewerDependencies {
  mailboxSyncRepository: MailboxSyncRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  tenantRepository: TenantRepository;
  encryptionUtil: EncryptionUtil;
  gmailWatch: GmailWatch;
  /** Injected so tests can pin "now"; the handler passes the clock. */
  now?: () => Date;
}

export type GmailWatchRenewer = (
  event: Pick<ScheduledEvent, 'time'>,
) => Promise<GmailWatchRenewalSummary>;

export interface GmailWatchRenewalSummary {
  checked: number;
  renewed: number;
  markedNeedsReconnect: number;
  failed: number;
}

/**
 * Gmail watches live 7 days; this renews every one with less than this left. Ticks come every
 * 12 hours (infra), so a watch gets three attempts before it lapses. A lapsed watch is renewed
 * too; the next push then lists history from the stored cursor, so nothing is lost as long as
 * Gmail still has that history (about a week).
 */
export const WATCH_RENEWAL_WINDOW_MS = 36 * 60 * 60 * 1000;

/** The tenant's client and topic, looked up once per tenant per run. */
interface TenantWatchContext {
  credentials: GoogleOAuthClientCredentials;
  topicName: string;
}

type MailboxOutcome = 'renewed' | 'needs_reconnect' | 'failed';

/**
 * One tick = renew every expiring watch, one mailbox at a time. A failure on one mailbox never
 * stops the others; it makes the run throw at the end so EventBridge's async retry re-runs the
 * tick, and by then the renewed mailboxes have a 7-day expiry and are not selected again.
 */
export function createGmailWatchRenewer(
  dependencies: GmailWatchRenewerDependencies,
): GmailWatchRenewer {
  const {
    mailboxSyncRepository,
    mailboxConnectionRepository,
    tenantRepository,
    encryptionUtil,
    gmailWatch,
    now = () => new Date(),
  } = dependencies;

  async function findTenantWatchContext(
    tenantId: string,
    cache: Map<string, TenantWatchContext | undefined>,
  ): Promise<TenantWatchContext | undefined> {
    if (cache.has(tenantId)) return cache.get(tenantId);
    const [tenantClient, pubsubPush] = await Promise.all([
      tenantRepository.findTenantGoogleClient(tenantId),
      tenantRepository.findTenantPubsubPush(tenantId),
    ]);
    const context =
      tenantClient && pubsubPush
        ? {
            credentials: {
              clientId: tenantClient.clientId,
              clientSecret: encryptionUtil.decryptSecret(tenantClient.encryptedClientSecret),
            },
            topicName: pubsubPush.topicName,
          }
        : undefined;
    cache.set(tenantId, context);
    return context;
  }

  async function renewMailboxWatch(
    mailbox: MailboxForWatchRenewal,
    tenantContexts: Map<string, TenantWatchContext | undefined>,
  ): Promise<MailboxOutcome> {
    const scope = { mailboxId: mailbox.mailboxId, tenantId: mailbox.tenantId };
    const context = {
      ...scope,
      emailAddress: mailbox.emailAddress,
      watchExpiresAt: mailbox.watchExpiresAt?.toISOString() ?? null,
    };
    try {
      const tenantContext = await findTenantWatchContext(mailbox.tenantId, tenantContexts);
      if (!tenantContext) {
        log('error', 'watch not renewed: tenant has no Google client or Pub/Sub topic', context);
        return 'failed';
      }
      const refreshToken = encryptionUtil.decryptSecret(mailbox.encryptedRefreshToken);
      let watch;
      try {
        watch = await gmailWatch.startWatch({
          credentials: tenantContext.credentials,
          refreshToken,
          topicName: tenantContext.topicName,
        });
      } catch (error) {
        const gmailError = toGmailApiError(error);
        if (gmailError.code === 'invalid_grant') {
          await mailboxConnectionRepository.markGmailNeedsReconnect(scope);
          log('warn', 'refresh token dead: mailbox marked needs_reconnect', context);
          return 'needs_reconnect';
        }
        log('error', 'watch renewal failed', {
          ...context,
          code: gmailError.code,
          detail: gmailError.message,
        });
        return 'failed';
      }
      await mailboxSyncRepository.saveWatchExpiry(scope, watch.expiresAt);
      log('info', 'watch renewed', { ...context, newExpiresAt: watch.expiresAt.toISOString() });
      return 'renewed';
    } catch (error) {
      // Tenant lookup, decryption or a repository write: this mailbox fails, the others still run.
      log('error', 'watch renewal failed outside the Gmail call', {
        ...context,
        detail: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
  }

  return async (event) => {
    const deadline = new Date(now().getTime() + WATCH_RENEWAL_WINDOW_MS);
    const mailboxes = await mailboxSyncRepository.findMailboxesWithWatchExpiringBefore(deadline);
    const tenantContexts = new Map<string, TenantWatchContext | undefined>();
    const summary: GmailWatchRenewalSummary = {
      checked: mailboxes.length,
      renewed: 0,
      markedNeedsReconnect: 0,
      failed: 0,
    };
    for (const mailbox of mailboxes) {
      const outcome = await renewMailboxWatch(mailbox, tenantContexts);
      if (outcome === 'renewed') summary.renewed += 1;
      else if (outcome === 'needs_reconnect') summary.markedNeedsReconnect += 1;
      else summary.failed += 1;
    }
    log(summary.failed > 0 ? 'error' : 'info', 'watch renewal tick done', {
      tickTime: event.time,
      deadline: deadline.toISOString(),
      ...summary,
    });
    if (summary.failed > 0) {
      throw new Error(`${summary.failed} of ${summary.checked} watch renewals failed`);
    }
    return summary;
  };
}
