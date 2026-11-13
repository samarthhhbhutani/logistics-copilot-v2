import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import { z } from 'zod';
import {
  GmailApiError,
  createGmailConnectStateToken,
  missingGmailScopes,
  verifyGmailConnectStateToken,
} from '@lc/core';
import type {
  GmailOAuth,
  GmailWatch,
  GoogleOAuthClientCredentials,
  MailboxConnection,
  MailboxConnectionRepository,
  EncryptionUtil,
  TenantRepository,
} from '@lc/core';
import {
  updateMailboxSignatureRequestSchema,
  type GmailConnectResponse,
  type MailboxResponse,
} from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import { parseRequestBody } from '../http/parseRequestBody.js';
import { sendConnectFlowOutcome } from './connectFlowOutcome.js';

export interface GmailConnectionRouterDependencies {
  mailboxConnectionRepository: MailboxConnectionRepository;
  tenantRepository: TenantRepository;
  gmailOAuth: GmailOAuth;
  gmailWatch: GmailWatch;
  encryptionUtil: EncryptionUtil;
  requireSession: RequestHandler;
  /** Signs the OAuth state; the session secret, shared so there is one key to rotate. */
  sessionSecret: string;
  frontendUrl: string | undefined;
}

const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

/**
 * The signed-in person's own mailbox (singular: one login is one mailbox).
 *   GET    /               what the frontend shows: address and Gmail connection status
 *   POST   /gmail/connect  returns the Google consent URL for a full-page redirect
 *   GET    /gmail/callback Google returns here; no session cookie, the signed `state` names the mailbox.
 *                          Stores the token and starts the Gmail watch on the tenant's Pub/Sub topic
 *   DELETE /gmail          stop the watch, revoke at Google and forget the token
 *   PATCH  /signature      store the plain-text signature appended to every mail sent from here
 */
export function createGmailConnectionRouter({
  mailboxConnectionRepository,
  tenantRepository,
  gmailOAuth,
  gmailWatch,
  encryptionUtil,
  requireSession,
  sessionSecret,
  frontendUrl,
}: GmailConnectionRouterDependencies): Router {
  const router = express.Router();

  async function loadTenantCredentials(
    tenantId: string,
  ): Promise<GoogleOAuthClientCredentials | undefined> {
    const tenantClient = await tenantRepository.findTenantGoogleClient(tenantId);
    if (!tenantClient) return undefined;
    return {
      clientId: tenantClient.clientId,
      clientSecret: encryptionUtil.decryptSecret(tenantClient.encryptedClientSecret),
    };
  }

  router.get('/', requireSession, async (_request, response) => {
    const connection = await mailboxConnectionRepository.findMailboxConnection(
      getSession(response),
    );
    if (!connection) throw createHttpError(404, 'mailbox_not_found');
    response.json(toMailboxView(connection));
  });

  // Returns the consent URL instead of redirecting: the frontend calls this with fetch(), which
  // cannot follow a cross-origin redirect to Google, so the SPA sets window.location itself.
  router.post('/gmail/connect', requireSession, async (_request, response) => {
    const session = getSession(response);
    const connection = await mailboxConnectionRepository.findMailboxConnection(session);
    if (!connection) throw createHttpError(404, 'mailbox_not_found');
    const credentials = await loadTenantCredentials(session.tenantId);
    if (!credentials) throw createHttpError(409, 'google_client_not_configured');
    // Checked before sending the user to Google: a consent that cannot be followed by a watch
    // would only have to be revoked again in the callback.
    if (!(await tenantRepository.findTenantPubsubPush(session.tenantId))) {
      throw createHttpError(409, 'pubsub_not_configured');
    }
    const state = await createGmailConnectStateToken(session, sessionSecret);
    response.json({
      url: gmailOAuth.buildConsentUrl({ credentials, state, loginHint: connection.emailAddress }),
    } satisfies GmailConnectResponse);
  });

  router.get('/gmail/callback', async (request, response) => {
    const query = parseRequestBody(callbackQuerySchema, request.query);
    const finish = (outcome: Parameters<typeof sendConnectFlowOutcome>[1]) =>
      sendConnectFlowOutcome(response, outcome, frontendUrl);

    // Verify the signed state first: it is the only proof this callback belongs to a connect we
    // started, so a forged or expired request is turned away before any lookup or Google call.
    const scope = query.state
      ? await verifyGmailConnectStateToken(query.state, sessionSecret)
      : undefined;
    if (!scope) return finish({ connected: false, error: 'invalid_state' });
    if (query.error || !query.code) return finish({ connected: false, error: 'denied' });

    const connection = await mailboxConnectionRepository.findMailboxConnection(scope);
    if (!connection) return finish({ connected: false, error: 'invalid_state' });
    const credentials = await loadTenantCredentials(scope.tenantId);
    if (!credentials) return finish({ connected: false, error: 'google_client_not_configured' });

    let consent;
    try {
      consent = await gmailOAuth.exchangeAuthorizationCode({ credentials, code: query.code });
    } catch (error) {
      // Codes are single-use and expire within minutes (back button, double callback): nothing to
      // repair server-side, the frontend just offers "try again".
      console.error('gmail code exchange failed', error);
      return finish({ connected: false, error: 'exchange_failed' });
    }

    // The anti-linking rule: the inbox we were granted must be the one this login was created for.
    if (consent.accountEmail !== connection.emailAddress) {
      await gmailOAuth.revokeRefreshToken({ credentials, refreshToken: consent.refreshToken });
      return finish({
        connected: false,
        error: 'email_mismatch',
        expectedEmail: connection.emailAddress,
      });
    }

    // A token without mail access would show "connected" and then fail at the first fetch; better
    // to revoke it now and ask the user to tick the Gmail box on a second attempt.
    const missingScopes = missingGmailScopes(consent.grantedScopes);
    if (missingScopes.length > 0) {
      console.warn('gmail scopes missing from consent', missingScopes);
      await gmailOAuth.revokeRefreshToken({ credentials, refreshToken: consent.refreshToken });
      return finish({ connected: false, error: 'scope_not_granted' });
    }

    // Start the watch before saving: a token we cannot watch with is a connection that would never
    // receive mail, so it is revoked and the onboarding mistake reported instead of a false
    // "connected". The watch response also hands us the history cursor ingestion starts from.
    const pubsubPush = await tenantRepository.findTenantPubsubPush(scope.tenantId);
    if (!pubsubPush) {
      await gmailOAuth.revokeRefreshToken({ credentials, refreshToken: consent.refreshToken });
      return finish({ connected: false, error: 'pubsub_not_configured' });
    }
    let watch;
    try {
      watch = await gmailWatch.startWatch({
        credentials,
        refreshToken: consent.refreshToken,
        topicName: pubsubPush.topicName,
      });
    } catch (error) {
      console.error('gmail watch failed', error instanceof GmailApiError ? error.code : error);
      await gmailOAuth.revokeRefreshToken({ credentials, refreshToken: consent.refreshToken });
      return finish({ connected: false, error: 'watch_failed' });
    }

    // The refresh token is the long-lived key to the inbox: only its AES-GCM ciphertext reaches
    // the database, decrypted again just before each Google call.
    await mailboxConnectionRepository.saveGmailConnection(scope, {
      encryptedRefreshToken: encryptionUtil.encryptSecret(consent.refreshToken),
      lastHistoryId: watch.historyId,
      watchExpiresAt: watch.expiresAt,
    });
    return finish({ connected: true });
  });

  router.patch('/signature', requireSession, async (request, response) => {
    const session = getSession(response);
    const { signature } = parseRequestBody(updateMailboxSignatureRequestSchema, request.body);
    if (!(await mailboxConnectionRepository.findMailboxConnection(session))) {
      throw createHttpError(404, 'mailbox_not_found');
    }
    // Stored trimmed, and a blank signature is no signature: composeOutboundMime appends nothing for null.
    const trimmedSignature = signature?.trim() || null;
    await mailboxConnectionRepository.updateSignature(session, trimmedSignature);
    const connection = await mailboxConnectionRepository.findMailboxConnection(session);
    if (!connection) throw createHttpError(404, 'mailbox_not_found');
    response.json(toMailboxView(connection));
  });

  router.delete('/gmail', requireSession, async (_request, response) => {
    const session = getSession(response);
    const connection = await mailboxConnectionRepository.findMailboxConnection(session);
    if (!connection) throw createHttpError(404, 'mailbox_not_found');
    if (connection.encryptedRefreshToken) {
      const credentials = await loadTenantCredentials(session.tenantId);
      if (credentials) {
        const refreshToken = encryptionUtil.decryptSecret(connection.encryptedRefreshToken);
        // Stop first: revoking would leave the watch publishing to the topic until it expires, and
        // every push would then fail at the token refresh for up to 7 days.
        try {
          await gmailWatch.stopWatch({ credentials, refreshToken });
        } catch (error) {
          console.error('gmail watch stop failed, revoking anyway', error);
        }
        try {
          await gmailOAuth.revokeRefreshToken({ credentials, refreshToken });
        } catch (error) {
          // Already revoked by the user, or Google unreachable: forgetting the token is still right.
          console.error('gmail revoke failed, clearing anyway', error);
        }
      }
    }
    await mailboxConnectionRepository.clearGmailConnection(session);
    response.status(204).end();
  });

  return router;
}

function toMailboxView(connection: MailboxConnection): MailboxResponse {
  return {
    mailboxId: connection.mailboxId,
    tenantId: connection.tenantId,
    emailAddress: connection.emailAddress,
    gmailConnectionStatus: connection.gmailConnectionStatus,
    gmailConnectedAt: connection.gmailConnectedAt?.toISOString() ?? null,
    watchExpiresAt: connection.watchExpiresAt?.toISOString() ?? null,
    signature: connection.signature,
  };
}
