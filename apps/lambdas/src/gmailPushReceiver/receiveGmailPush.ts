import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { toGmailApiError } from '@lc/core';
import type {
  EncryptionUtil,
  GmailApiError,
  GmailHistory,
  GmailHistoryPage,
  MailboxConnectionRepository,
  MailboxForPush,
  MailboxScope,
  MailboxSyncRepository,
  TenantRepository,
} from '@lc/core';
import type { GmailMessageIdPublisher } from './gmailMessageIdPublisher.js';
import { parseGmailPushNotification } from './gmailPushNotification.js';
import type { PushTokenVerifier } from './pushTokenVerifier.js';
import { log } from '../structuredLog.js';

export interface GmailPushReceiverDependencies {
  pushTokenVerifier: PushTokenVerifier;
  mailboxSyncRepository: MailboxSyncRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  tenantRepository: TenantRepository;
  encryptionUtil: EncryptionUtil;
  gmailHistory: GmailHistory;
  gmailMessageIdPublisher: GmailMessageIdPublisher;
}

export type GmailPushHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

const NO_CONTENT: APIGatewayProxyResultV2 = { statusCode: 204 };

/** A connected mailbox with a cursor behind this push: what history.list needs. */
interface SyncableMailbox {
  encryptedRefreshToken: string;
  lastHistoryId: bigint;
}

/**
 * One Pub/Sub push = "this mailbox changed". Everything after authentication answers 204: the
 * stored cursor makes the next push replay whatever this one could not finish, and a 5xx would
 * only make Pub/Sub redeliver a wake-up we no longer need. Duplicate ids are expected and die in
 * emailProcessor (one row per mailbox + Gmail message id).
 */
export function createGmailPushReceiver(
  dependencies: GmailPushReceiverDependencies,
): GmailPushHandler {
  const {
    pushTokenVerifier,
    mailboxSyncRepository,
    mailboxConnectionRepository,
    tenantRepository,
    encryptionUtil,
    gmailHistory,
    gmailMessageIdPublisher,
  } = dependencies;

  /** Undefined when this push needs no history.list; the reason is logged, and a null cursor is repaired. */
  async function checkSyncableMailbox(
    mailbox: MailboxForPush,
    scope: MailboxScope,
    pushHistoryId: bigint,
    context: Record<string, string>,
  ): Promise<SyncableMailbox | undefined> {
    if (mailbox.gmailConnectionStatus !== 'connected' || !mailbox.encryptedRefreshToken) {
      log('info', 'push skipped: mailbox not connected', {
        ...context,
        status: mailbox.gmailConnectionStatus,
      });
      return undefined;
    }
    if (mailbox.lastHistoryId === null) {
      // A connect always stores the watch's historyId; a null cursor on a connected mailbox is
      // older data. Start from this push rather than guess.
      await mailboxSyncRepository.resetHistoryCursor(scope, pushHistoryId);
      log('warn', 'cursor was null on a connected mailbox: reset to the push', context);
      return undefined;
    }
    if (pushHistoryId <= mailbox.lastHistoryId) {
      log('info', 'push skipped: cursor already covers it', {
        ...context,
        cursor: mailbox.lastHistoryId.toString(),
      });
      return undefined;
    }
    return {
      encryptedRefreshToken: mailbox.encryptedRefreshToken,
      lastHistoryId: mailbox.lastHistoryId,
    };
  }

  /** Each failure decides what happens to the cursor; none is retried by Pub/Sub (always 204). */
  async function recoverFromHistoryFailure(
    error: GmailApiError,
    scope: MailboxScope,
    cursor: bigint,
    pushHistoryId: bigint,
    context: Record<string, string>,
  ): Promise<void> {
    switch (error.code) {
      case 'invalid_grant':
        await mailboxConnectionRepository.markGmailNeedsReconnect(scope);
        log('warn', 'refresh token dead: mailbox marked needs_reconnect', context);
        return;
      case 'not_found':
        // Gmail keeps history for a limited window; past it the only option is to restart from
        // this push. Mail changed in between is not ingested (user decision 11-08: no resync).
        await mailboxSyncRepository.resetHistoryCursor(scope, pushHistoryId);
        log('error', 'history gap: cursor too old, reset to the push', {
          ...context,
          cursor: cursor.toString(),
        });
        return;
      default:
        log('error', 'history.list failed, cursor untouched', {
          ...context,
          code: error.code,
          detail: error.message,
        });
    }
  }

  return async (event) => {
    const pushToken = await pushTokenVerifier.verify({
      authorizationHeader: event.headers.authorization,
      expectedAudienceHost: event.requestContext.domainName,
    });
    if (!pushToken) {
      log('warn', 'push rejected: no valid Google OIDC token');
      return { statusCode: 401 };
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : event.body;
    const notification = parseGmailPushNotification(rawBody);
    if (!notification) {
      log('warn', 'push rejected: body is not a Gmail notification', { caller: pushToken.email });
      return { statusCode: 400 };
    }
    const { emailAddress, historyId: pushHistoryId, pubsubMessageId } = notification;
    const context = { emailAddress, pushHistoryId: pushHistoryId.toString(), pubsubMessageId };

    const mailbox = await mailboxSyncRepository.findMailboxForPush(emailAddress);
    if (!mailbox) {
      log('info', 'push skipped: no mailbox for address', context);
      return NO_CONTENT;
    }
    if (pushToken.email !== mailbox.pushServiceAccountEmail) {
      log('warn', 'push rejected: token identity is not the tenant push service account', {
        ...context,
        caller: pushToken.email,
      });
      return { statusCode: 403 };
    }
    const scope = { mailboxId: mailbox.mailboxId, tenantId: mailbox.tenantId };
    const syncableMailbox = await checkSyncableMailbox(mailbox, scope, pushHistoryId, context);
    if (!syncableMailbox) return NO_CONTENT;

    const tenantClient = await tenantRepository.findTenantGoogleClient(mailbox.tenantId);
    if (!tenantClient) {
      log('error', 'push skipped: tenant has no Google client', context);
      return NO_CONTENT;
    }
    const credentials = {
      clientId: tenantClient.clientId,
      clientSecret: encryptionUtil.decryptSecret(tenantClient.encryptedClientSecret),
    };
    const refreshToken = encryptionUtil.decryptSecret(syncableMailbox.encryptedRefreshToken);

    let history: GmailHistoryPage;
    try {
      history = await gmailHistory.listMessagesAddedSince({
        credentials,
        refreshToken,
        startHistoryId: syncableMailbox.lastHistoryId,
      });
    } catch (error) {
      await recoverFromHistoryFailure(
        toGmailApiError(error),
        scope,
        syncableMailbox.lastHistoryId,
        pushHistoryId,
        context,
      );
      return NO_CONTENT;
    }

    if (history.messageIds.length > 0) {
      try {
        await gmailMessageIdPublisher.publish(scope, history.messageIds);
      } catch (error) {
        log('error', 'publish failed, cursor untouched', {
          ...context,
          detail: error instanceof Error ? error.message : String(error),
        });
        return NO_CONTENT;
      }
    }
    const advanced = await mailboxSyncRepository.advanceHistoryCursor(scope, history.historyId);
    log('info', 'push handled', {
      ...context,
      enqueued: history.messageIds.length,
      newCursor: history.historyId.toString(),
      cursorAdvanced: advanced,
    });
    return NO_CONTENT;
  };
}
