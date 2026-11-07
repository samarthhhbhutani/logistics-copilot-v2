import { OAuth2Client } from 'google-auth-library';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';

/** A tenant's own Google OAuth client, secret already decrypted. Never stored in this form. */
export interface GoogleOAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** What one successful consent yields: the long-lived token, whose inbox it opens, and how much of it. */
export interface GmailConsentResult {
  refreshToken: string;
  /** From the verified id_token, lowercased. The caller must compare it with the mailbox address. */
  accountEmail: string;
  /**
   * Scopes Google actually granted. Since 2024 the consent screen shows each Gmail scope as a
   * checkbox the user can leave unticked and still press Continue, so a token can come back
   * without any mail access. The caller must check the Gmail scopes are all present.
   */
  grantedScopes: string[];
}

/**
 * The three Google OAuth operations the connect flow needs, behind an interface so route tests
 * use an in-memory fake. Every call takes the tenant's credentials because clients are per
 * tenant; nothing here caches a client.
 */
export interface GmailOAuth {
  buildConsentUrl(input: {
    credentials: GoogleOAuthClientCredentials;
    state: string;
    loginHint: string;
  }): string;
  exchangeAuthorizationCode(input: {
    credentials: GoogleOAuthClientCredentials;
    code: string;
  }): Promise<GmailConsentResult>;
  revokeRefreshToken(input: {
    credentials: GoogleOAuthClientCredentials;
    refreshToken: string;
  }): Promise<void>;
}

/**
 * The Gmail scopes a connection is useless without; checked against what Google granted.
 * readonly feeds ingestion, send is for replies and RFQs. Adding a scope later forces every
 * mailbox to reconnect, so both are requested from the first connect.
 */
export const REQUIRED_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

/** Scopes requested at consent. The Gmail ones are restricted: Internal consent screens skip verification. */
export const GMAIL_OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  ...REQUIRED_GMAIL_SCOPES,
];

/** Required scopes the user left unticked on the consent screen. */
export function missingGmailScopes(grantedScopes: string[]): string[] {
  return REQUIRED_GMAIL_SCOPES.filter((scope) => !grantedScopes.includes(scope));
}

export class GmailOAuthError extends Error {
  constructor(
    readonly code: 'no_refresh_token' | 'id_token_missing' | 'id_token_without_email',
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GmailOAuthError';
  }
}

/**
 * The real implementation over google-auth-library. Each operation builds an OAuth2Client, a plain
 * in-memory object (no network) holding the three values Google needs to recognise our app for
 * one tenant: the tenant's client id and secret plus our shared callback URL.
 *
 * @param redirectUri `Config.GOOGLE_REDIRECT_URI`, registered on every tenant's client.
 */
export function createGoogleGmailOAuth({ redirectUri }: { redirectUri: string }): GmailOAuth {
  function createOAuthClient({ clientId, clientSecret }: GoogleOAuthClientCredentials) {
    return new OAuth2Client({ clientId, clientSecret, redirectUri });
  }

  return {
    // access_type=offline is what makes Google return a refresh token; prompt=consent forces the
    // consent screen even when the user granted before, which is the only way to get a refresh
    // token again after a disconnect. login_hint preselects the mailbox's account.
    buildConsentUrl({ credentials, state, loginHint }) {
      return createOAuthClient(credentials).generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: GMAIL_OAUTH_SCOPES,
        state,
        login_hint: loginHint,
        include_granted_scopes: true,
      });
    },

    // Trades the one-time code from the callback for tokens, then reads the account email from
    // the id_token (openid + email scopes) instead of a second API call. Google signs the
    // id_token; verifyIdToken checks signature, expiry, issuer and that it was minted for this
    // tenant's client.
    exchangeAuthorizationCode({ credentials, code }) {
      return runInsideSpan('gmail.oauth.exchange_code', async () => {
        const oauthClient = createOAuthClient(credentials);
        const { tokens } = await oauthClient.getToken(code);
        if (!tokens.refresh_token) {
          throw new GmailOAuthError('no_refresh_token', 'consent did not include offline access');
        }
        if (!tokens.id_token) throw new GmailOAuthError('id_token_missing');
        const ticket = await oauthClient.verifyIdToken({
          idToken: tokens.id_token,
          audience: credentials.clientId,
        });
        const email = ticket.getPayload()?.email;
        if (!email) throw new GmailOAuthError('id_token_without_email');
        return {
          refreshToken: tokens.refresh_token,
          accountEmail: email.toLowerCase(),
          // Google returns the granted set space-separated in the token response.
          grantedScopes: tokens.scope?.split(' ').filter(Boolean) ?? [],
        };
      });
    },

    // Tells Google to invalidate the grant, so the token is dead even if a database copy leaks
    // later. Called on disconnect and when a consent came from the wrong Google account.
    revokeRefreshToken({ credentials, refreshToken }) {
      return runInsideSpan('gmail.oauth.revoke', async () => {
        await createOAuthClient(credentials).revokeToken(refreshToken);
      });
    },
  };
}
