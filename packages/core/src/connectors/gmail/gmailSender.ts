import { OAuth2Client } from 'google-auth-library';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';
import { composeOutboundMime, type OutboundMessage } from '../../utils/mime/composeOutboundMime.js';
import type { GoogleOAuthClientCredentials } from './gmailOAuth.js';
import { toGmailApiError } from './gmailApiError.js';
import {
  assertOutboundRedirectMatchesStage,
  redirectOutboundMessage,
  type OutboundMailSafeModeOptions,
} from '../../utils/mime/outboundMailSafeMode.js';

export interface GmailSendResult {
  gmailMessageId: string;
  /** The thread Gmail filed it in: the given `threadId`, or a new one for a fresh mail. */
  gmailThreadId: string;
}

export interface GmailSender {
  /**
   * messages.send with the message as RFC 822 bytes. `threadId` keeps a reply in the Gmail
   * thread of the mail it answers (Gmail also wants matching In-Reply-To/References and
   * subject for that). Throws GmailApiError like every other Gmail call.
   */
  sendMessage(input: {
    credentials: GoogleOAuthClientCredentials;
    refreshToken: string;
    message: OutboundMessage;
    threadId?: string;
  }): Promise<GmailSendResult>;
}

interface MessageSendResponse {
  id: string;
  threadId: string;
}

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** The JSON body messages.send takes: the RFC 822 bytes base64url-encoded, plus the thread. */
export function buildSendRequestBody(
  rawMessage: Uint8Array,
  threadId: string | undefined,
): { raw: string; threadId?: string } {
  const raw = Buffer.from(rawMessage).toString('base64url');
  return threadId === undefined ? { raw } : { raw, threadId };
}

/** Plain REST via OAuth2Client.request, like gmailMessages, gmailHistory and gmailWatch. */
export function createGoogleGmailSender(options: OutboundMailSafeModeOptions): GmailSender {
  assertOutboundRedirectMatchesStage(options);
  return {
    sendMessage({ credentials, refreshToken, message, threadId }) {
      return runInsideSpan('gmail.send', async (span) => {
        const messageToSend =
          options.redirectAllMailTo === undefined
            ? message
            : redirectOutboundMessage(message, options.redirectAllMailTo);
        const rawMessage = await composeOutboundMime(messageToSend);
        span.setAttributes({
          'gmail.message.size_bytes': rawMessage.byteLength,
          'gmail.send.redirected': options.redirectAllMailTo !== undefined,
          'gmail.send.is_reply': threadId !== undefined,
        });

        const oauthClient = new OAuth2Client({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
        });
        oauthClient.setCredentials({ refresh_token: refreshToken });

        let sent: MessageSendResponse;
        try {
          const response = await oauthClient.request<MessageSendResponse>({
            url: GMAIL_SEND_URL,
            method: 'POST',
            data: buildSendRequestBody(rawMessage, threadId),
          });
          sent = response.data;
        } catch (error) {
          throw toGmailApiError(error);
        }
        return { gmailMessageId: sent.id, gmailThreadId: sent.threadId };
      });
    },
  };
}
