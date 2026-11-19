import createHttpError from 'http-errors';
import type {
  EncryptionUtil,
  GoogleOAuthClientCredentials,
  InlineImage,
  MailboxConnection,
  MailboxConnectionRepository,
  MailboxScope,
  SignatureImageRepository,
  TenantRepository,
} from '@lc/core';
import { loadSignatureInlineImages } from '../signature/loadSignatureInlineImages.js';
import type { SignatureImageStore } from '../signature/signatureImageStore.js';

export interface SendingMailbox {
  connection: MailboxConnection;
  credentials: GoogleOAuthClientCredentials;
  refreshToken: string;
  /** The HTML signature's images with their bytes; empty for a text-only signature. */
  inlineImages: InlineImage[];
}

export interface SendingMailboxDependencies {
  mailboxConnectionRepository: MailboxConnectionRepository;
  tenantRepository: TenantRepository;
  encryptionUtil: EncryptionUtil;
  signatureImageRepository: SignatureImageRepository;
  signatureImageStore: SignatureImageStore | undefined;
}

/**
 * Everything messages.send needs for the session's mailbox, decrypted. 404 mailbox_not_found;
 * 409 mailbox_not_connected when Gmail is not (or no longer) connected; 409
 * google_client_not_configured when the tenant has no OAuth client.
 */
export async function loadSendingMailbox(
  {
    mailboxConnectionRepository,
    tenantRepository,
    encryptionUtil,
    signatureImageRepository,
    signatureImageStore,
  }: SendingMailboxDependencies,
  scope: MailboxScope,
): Promise<SendingMailbox> {
  const connection = await mailboxConnectionRepository.findMailboxConnection(scope);
  if (!connection) throw createHttpError(404, 'mailbox_not_found');
  if (connection.gmailConnectionStatus !== 'connected' || !connection.encryptedRefreshToken) {
    throw createHttpError(409, 'mailbox_not_connected');
  }
  const tenantClient = await tenantRepository.findTenantGoogleClient(scope.tenantId);
  if (!tenantClient) throw createHttpError(409, 'google_client_not_configured');
  return {
    connection,
    credentials: {
      clientId: tenantClient.clientId,
      clientSecret: encryptionUtil.decryptSecret(tenantClient.encryptedClientSecret),
    },
    refreshToken: encryptionUtil.decryptSecret(connection.encryptedRefreshToken),
    inlineImages: await loadSignatureInlineImages(
      { signatureImageRepository, signatureImageStore },
      scope,
      connection,
    ),
  };
}
