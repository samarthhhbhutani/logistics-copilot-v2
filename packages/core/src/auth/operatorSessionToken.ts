import { SignJWT, jwtVerify } from 'jose';

/** What an operator session proves: which operator account signed in. Not scoped to any tenant. */
export interface OperatorSessionClaims {
  operatorId: string;
  email: string;
}

const OPERATOR_TOKEN_ALGORITHM = 'HS256';
/** Distinct issuer so an operator token never verifies as a mailbox session, nor the reverse. */
const OPERATOR_TOKEN_ISSUER = 'logistics-copilot/operator';
/** One working day: onboarding is done in sittings, and the credential is far more powerful than a mailbox login. */
export const OPERATOR_TOKEN_TTL_SECONDS = 8 * 60 * 60;

/** Same stateless HMAC JWT as createSessionToken, signed with the same SESSION_SECRET. */
export async function createOperatorSessionToken(
  claims: OperatorSessionClaims,
  sessionSecret: string,
): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: OPERATOR_TOKEN_ALGORITHM })
    .setSubject(claims.operatorId)
    .setIssuer(OPERATOR_TOKEN_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${OPERATOR_TOKEN_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(sessionSecret));
}

/** Returns the claims, or undefined for any invalid, expired, foreign or mailbox-session token. */
export async function verifyOperatorSessionToken(
  token: string,
  sessionSecret: string,
): Promise<OperatorSessionClaims | undefined> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(sessionSecret), {
      algorithms: [OPERATOR_TOKEN_ALGORITHM],
      issuer: OPERATOR_TOKEN_ISSUER,
    });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return undefined;
    return { operatorId: payload.sub, email: payload.email };
  } catch {
    return undefined;
  }
}
