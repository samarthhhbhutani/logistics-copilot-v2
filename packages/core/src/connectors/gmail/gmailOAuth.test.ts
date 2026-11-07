import { describe, expect, it } from 'vitest';
import { GMAIL_OAUTH_SCOPES, createGoogleGmailOAuth, missingGmailScopes } from './gmailOAuth.js';

describe('createGoogleGmailOAuth().buildConsentUrl()', () => {
  it('points at Google with offline access, forced consent, our scopes, the state and the login hint', () => {
    const gmailOAuth = createGoogleGmailOAuth({
      redirectUri: 'http://localhost:8080/v1/mailbox/gmail/callback',
    });
    const url = new URL(
      gmailOAuth.buildConsentUrl({
        credentials: { clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'secret' },
        state: 'signed-state',
        loginHint: 'ops@bhatia.example',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-id.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8080/v1/mailbox/gmail/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(GMAIL_OAUTH_SCOPES);
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('login_hint')).toBe('ops@bhatia.example');
    expect(url.searchParams.has('client_secret')).toBe(false);
  });
});

describe('missingGmailScopes', () => {
  it('is empty when everything requested was granted, lists the Gmail scopes otherwise', () => {
    expect(missingGmailScopes(GMAIL_OAUTH_SCOPES)).toEqual([]);
    expect(missingGmailScopes(['openid', 'email'])).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ]);
    expect(
      missingGmailScopes(['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']),
    ).toEqual(['https://www.googleapis.com/auth/gmail.send']);
  });
});
