import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { withTransaction } from './database.js';

export type AuthenticatedUser = {
  id: string;
  subject: string;
  email: string;
  displayName: string;
  claims: JWTPayload;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

let remoteKeySet: ReturnType<typeof createRemoteJWKSet> | undefined;

function authConfiguration() {
  const jwksUrl = process.env.AUTH_JWKS_URL;
  const issuer = process.env.AUTH_ISSUER;
  const audience = process.env.AUTH_AUDIENCE;

  if (!jwksUrl || !issuer || !audience) {
    const error = new Error(
      'AUTH_JWKS_URL, AUTH_ISSUER, and AUTH_AUDIENCE must be configured',
    ) as Error & { status?: number };
    error.status = 503;
    throw error;
  }

  remoteKeySet ??= createRemoteJWKSet(new URL(jwksUrl));
  return { issuer, audience, keySet: remoteKeySet };
}

function bearerToken(request: Request): string {
  const authorization = request.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    const error = new Error('Bearer token is required') as Error & { status?: number };
    error.status = 401;
    throw error;
  }
  return authorization.slice('Bearer '.length).trim();
}

/**
 * jose error codes caused by the presented token itself: malformed, bad
 * signature, a key or algorithm the JWKS does not offer, expired, or the wrong
 * issuer or audience. These are the client's credential problem (401). JWKS
 * retrieval failures (ERR_JWKS_TIMEOUT, ERR_JWKS_INVALID) and anything else
 * are not listed: they stay server errors.
 */
const TOKEN_REJECTION_CODES = new Set([
  'ERR_JWS_INVALID',
  'ERR_JWT_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

export function isTokenRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TOKEN_REJECTION_CODES.has(code);
}

/** Verifies the token; a token the client got wrong becomes a 401 without jose's details. */
async function verifyToken(token: string, keySet: ReturnType<typeof createRemoteJWKSet>, issuer: string, audience: string) {
  try {
    return await jwtVerify(token, keySet, { issuer, audience });
  } catch (cause) {
    if (!isTokenRejection(cause)) throw cause;
    const error = new Error('Invalid or expired access token', { cause }) as Error & { status?: number };
    error.status = 401;
    throw error;
  }
}

function requiredStringClaim(
  payload: JWTPayload,
  key: 'sub' | 'email',
): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`JWT ${key} claim is required`) as Error & { status?: number };
    error.status = 401;
    throw error;
  }
  return value.trim();
}

export async function authenticate(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  try {
    const token = bearerToken(request);
    const { issuer, audience, keySet } = authConfiguration();
    const verified = await verifyToken(token, keySet, issuer, audience);
    const subject = requiredStringClaim(verified.payload, 'sub');
    const email = requiredStringClaim(verified.payload, 'email').toLowerCase();
    const displayName =
      typeof verified.payload.name === 'string' && verified.payload.name.trim()
        ? verified.payload.name.trim()
        : email;

    const userId = await withTransaction(async (client) => {
      const result = await client.query<{ user_id: string }>(
        'select public.sync_authenticated_user($1, $2, $3) as user_id',
        [subject, displayName, email],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Unable to synchronize authenticated user');
      return row.user_id;
    });

    request.user = {
      id: userId,
      subject,
      email,
      displayName,
      claims: verified.payload,
    };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireUser(request: Request): AuthenticatedUser {
  if (!request.user) {
    const error = new Error('Authentication is required') as Error & { status?: number };
    error.status = 401;
    throw error;
  }
  return request.user;
}
