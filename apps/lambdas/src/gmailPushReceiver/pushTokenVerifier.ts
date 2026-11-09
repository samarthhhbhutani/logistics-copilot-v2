import { OAuth2Client } from 'google-auth-library';

/** The identity Pub/Sub signed the push with. */
export interface VerifiedPushToken {
  email: string;
}

export interface PushTokenVerifier {
  /**
   * Checks the OIDC token Pub/Sub attaches to a push: Google signature, issuer, not expired, and
   * an audience whose host is this function's URL. Who the caller is (email) is returned for the
   * tenant check; whether that identity is allowed is the receiver's decision, not this one.
   */
  verify(input: {
    authorizationHeader: string | undefined;
    expectedAudienceHost: string;
  }): Promise<VerifiedPushToken | undefined>;
}

export function createGooglePushTokenVerifier(): PushTokenVerifier {
  // No client id: verifyIdToken only needs Google's public certs, which this client caches.
  const oauthClient = new OAuth2Client();
  return {
    async verify({ authorizationHeader, expectedAudienceHost }) {
      const idToken = authorizationHeader?.match(/^Bearer (.+)$/i)?.[1];
      if (!idToken) return undefined;
      try {
        // Audience is checked by host below: Pub/Sub sets it to the push endpoint URL as typed
        // into the subscription, and a trailing slash must not decide authentication.
        const ticket = await oauthClient.verifyIdToken({ idToken });
        const payload = ticket.getPayload();
        if (!payload?.email || payload.email_verified !== true) return undefined;
        const audience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
        if (!audience || !isSameHost(audience, expectedAudienceHost)) {
          // The one misconfiguration a tenant can make here: an audience typed into the
          // subscription that is not this endpoint. Logged so it is diagnosable from CloudWatch.
          console.warn(
            JSON.stringify({
              message: 'push token audience is not this endpoint',
              audience,
              email: payload.email,
              expectedAudienceHost,
            }),
          );
          return undefined;
        }
        return { email: payload.email };
      } catch {
        return undefined;
      }
    },
  };
}

function isSameHost(audience: string, expectedHost: string): boolean {
  try {
    return new URL(audience).host === expectedHost;
  } catch {
    return false;
  }
}
