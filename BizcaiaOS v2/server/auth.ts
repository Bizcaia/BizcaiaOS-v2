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
    const verified = await jwtVerify(token, keySet, { issuer, audience });
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
