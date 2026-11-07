import { GMAIL_OAUTH_SCOPES } from '@lc/core';
import type { GmailOAuth, GoogleOAuthClientCredentials } from '@lc/core';

export interface FakeGmailOAuth extends GmailOAuth {
  /** Which Google account "consents" on the next code exchange. */
  consentingAccountEmail: string;
  /** Set to make the exchange fail, as Google does for a reused or expired code. */
  failNextExchange: boolean;
  /** What the next consent grants; defaults to everything requested. */
  grantedScopes: string[];
  exchangedCodes: string[];
  revokedRefreshTokens: string[];
  credentialsSeen: GoogleOAuthClientCredentials[];
}

/** Stands in for Google: no network, deterministic tokens (`refresh-token-for:<code>`). */
export function createFakeGmailOAuth(consentingAccountEmail: string): FakeGmailOAuth {
  const fake: FakeGmailOAuth = {
    consentingAccountEmail,
    failNextExchange: false,
    grantedScopes: [...GMAIL_OAUTH_SCOPES],
    exchangedCodes: [],
    revokedRefreshTokens: [],
    credentialsSeen: [],
    buildConsentUrl({ credentials, state, loginHint }) {
      fake.credentialsSeen.push(credentials);
      const url = new URL('https://accounts.google.test/consent');
      url.searchParams.set('client_id', credentials.clientId);
      url.searchParams.set('state', state);
      url.searchParams.set('login_hint', loginHint);
      return url.toString();
    },
    async exchangeAuthorizationCode({ credentials, code }) {
      fake.credentialsSeen.push(credentials);
      fake.exchangedCodes.push(code);
      if (fake.failNextExchange) {
        fake.failNextExchange = false;
        throw new Error('invalid_grant');
      }
      return {
        refreshToken: `refresh-token-for:${code}`,
        accountEmail: fake.consentingAccountEmail,
        grantedScopes: fake.grantedScopes,
      };
    },
    async revokeRefreshToken({ refreshToken }) {
      fake.revokedRefreshTokens.push(refreshToken);
    },
  };
  return fake;
}
