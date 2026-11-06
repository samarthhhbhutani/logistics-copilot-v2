import { SignJWT, jwtVerify } from 'jose';

/** What a session proves: which mailbox (the account a person operates) and which tenant to scope every query to. */
export interface SessionClaims {
  mailboxId: string;
  tenantId: string;
}

const SESSION_TOKEN_ALGORITHM = 'HS256';
const SESSION_TOKEN_ISSUER = 'logistics-copilot';
export const SESSION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Stateless session: an HMAC-signed JWT the API hands out at login and reads back from the cookie.
 * No sessions table, so logout only clears the cookie and a token stays valid until it expires.
 * If instant revocation is ever needed, add mailbox_logins.token_version and compare it in requireSession.
 */
export async function createSessionToken(
  claims: SessionClaims,
  sessionSecret: string,
): Promise<string> {
  return new SignJWT({ tenantId: claims.tenantId })
    .setProtectedHeader({ alg: SESSION_TOKEN_ALGORITHM })
    .setSubject(claims.mailboxId)
    .setIssuer(SESSION_TOKEN_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TOKEN_TTL_SECONDS}s`)
    .sign(secretKeyBytes(sessionSecret));
}

/** Returns the claims, or undefined for any invalid, expired or foreign token. */
export async function verifySessionToken(
  token: string,
  sessionSecret: string,
): Promise<SessionClaims | undefined> {
  try {
    const { payload } = await jwtVerify(token, secretKeyBytes(sessionSecret), {
      algorithms: [SESSION_TOKEN_ALGORITHM],
      issuer: SESSION_TOKEN_ISSUER,
    });
    if (typeof payload.sub !== 'string' || typeof payload.tenantId !== 'string') return undefined;
    return { mailboxId: payload.sub, tenantId: payload.tenantId };
  } catch {
    return undefined;
  }
}

function secretKeyBytes(sessionSecret: string): Uint8Array {
  return new TextEncoder().encode(sessionSecret);
}
