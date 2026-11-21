import type {
  EncryptionUtil,
  InlineImage,
  MailboxConnectionRepository,
  MailboxScope,
  SignatureImageRepository,
  TenantRepository,
} from '@lc/core';
import { loadConnectedMailbox } from '../gmail/loadConnectedMailbox.js';
import type { ConnectedMailbox } from '../gmail/loadConnectedMailbox.js';
import { loadSignatureInlineImages } from '../signature/loadSignatureInlineImages.js';
import type { SignatureImageStore } from '../signature/signatureImageStore.js';

export interface SendingMailbox extends ConnectedMailbox {
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
 * Everything messages.send needs for the session's mailbox: the connected mailbox (404
 * mailbox_not_found; 409 mailbox_not_connected | google_client_not_configured) plus the signature's
 * images.
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
  const mailbox = await loadConnectedMailbox(
    { mailboxConnectionRepository, tenantRepository, encryptionUtil },
    scope,
  );
  return {
    ...mailbox,
    inlineImages: await loadSignatureInlineImages(
      { signatureImageRepository, signatureImageStore },
      scope,
      mailbox.connection,
    ),
  };
}
