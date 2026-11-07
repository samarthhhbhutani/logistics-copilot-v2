import { SignJWT, jwtVerify } from 'jose';
import type { SessionClaims } from '../../auth/sessionToken.js';

const STATE_TOKEN_ALGORITHM = 'HS256';
const STATE_TOKEN_ISSUER = 'logistics-copilot';
/** Distinct audience so a session cookie can never be replayed as a connect state, or vice versa. */
const STATE_TOKEN_AUDIENCE = 'gmail-connect';
export const GMAIL_CONNECT_STATE_TTL_SECONDS = 10 * 60;

/**
 * The OAuth `state` parameter as a short-lived signed JWT naming the mailbox being connected.
 * Google hands it back untouched on the callback, which arrives without our session cookie
 * (a top-level navigation from accounts.google.com), so the state is how the callback knows
 * which mailbox to attach the tokens to. Signed with the session secret, verified on return.
 */
export async function createGmailConnectStateToken(
  claims: SessionClaims,
  secret: string,
): Promise<string> {
  return new SignJWT({ tenantId: claims.tenantId })
    .setProtectedHeader({ alg: STATE_TOKEN_ALGORITHM })
    .setSubject(claims.mailboxId)
    .setIssuer(STATE_TOKEN_ISSUER)
    .setAudience(STATE_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${GMAIL_CONNECT_STATE_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));
}

/** The mailbox and tenant the state was issued for, or undefined for anything invalid or expired. */
export async function verifyGmailConnectStateToken(
  stateToken: string,
  secret: string,
): Promise<SessionClaims | undefined> {
  try {
    const { payload } = await jwtVerify(stateToken, new TextEncoder().encode(secret), {
      algorithms: [STATE_TOKEN_ALGORITHM],
      issuer: STATE_TOKEN_ISSUER,
      audience: STATE_TOKEN_AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || typeof payload.tenantId !== 'string') return undefined;
    return { mailboxId: payload.sub, tenantId: payload.tenantId };
  } catch {
    return undefined;
  }
}
