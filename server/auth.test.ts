import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// C-01: real jose verification of Supabase Auth-shaped access tokens against a
// local JWKS. No Supabase project is involved; keys are generated per run.
const sync = vi.hoisted(() => vi.fn());
vi.mock('./database.js', () => ({
  withTransaction: vi.fn(async (operation: (client: { query: typeof sync }) => Promise<unknown>) =>
    operation({ query: sync }),
  ),
}));

import { authenticate } from './auth.js';

const kid = 'test-es256-key';
let server: Server;
let issuer: string;
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;

function supabaseClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    iss: issuer,
    aud: 'authenticated',
    sub: '123e4567-e89b-12d3-a456-426614174000',
    email: 'User@Example.com',
    role: 'authenticated',
    is_anonymous: false,
    user_metadata: { name: 'Example User' },
    ...overrides,
  };
}

function sign(claims: JWTPayload, key: CryptoKey | Uint8Array = privateKey, alg = 'ES256') {
  return new SignJWT(claims).setProtectedHeader({ alg, kid, typ: 'JWT' }).setIssuedAt().setExpirationTime('5m').sign(key);
}

async function run(token: string | null) {
  const request = { header: (name: string) => (name === 'authorization' && token ? `Bearer ${token}` : undefined) } as unknown as Request;
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  await authenticate(request, {} as Response, next);
  return { request, error: next.mock.calls[0]?.[0] as (Error & { status?: number }) | undefined };
}

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  otherPrivateKey = (await generateKeyPair('ES256')).privateKey;
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: 'ES256', use: 'sig' }] };
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Supabase shape: issuer https://<ref>.supabase.co/auth/v1, JWKS under /.well-known/jwks.json.
  issuer = `${base}/auth/v1`;
  // Set directly: the shared test setup unstubs vi.stubEnv values after each test.
  Object.assign(process.env, {
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: 'authenticated',
    AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
  });
});

afterAll(async () => {
  for (const name of ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL']) delete process.env[name];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  sync.mockReset();
  sync.mockResolvedValue({ rows: [{ user_id: 'app-user-1' }] });
});

describe('authenticate with Supabase Auth access tokens', () => {
  it('accepts an ES256 token with the Supabase issuer, audience, sub and email', async () => {
    const { request, error } = await run(await sign(supabaseClaims()));
    expect(error).toBeUndefined();
    expect(request.user).toMatchObject({
      id: 'app-user-1',
      subject: '123e4567-e89b-12d3-a456-426614174000',
      email: 'user@example.com',
    });
    // name lives in user_metadata, not at the top level, so the display name falls back to the email.
    expect(sync).toHaveBeenCalledWith('select public.sync_authenticated_user($1, $2, $3) as user_id', [
      '123e4567-e89b-12d3-a456-426614174000',
      'user@example.com',
      'user@example.com',
    ]);
  });

  it.each([
    ['a wrong issuer', () => sign(supabaseClaims({ iss: 'https://other-project.supabase.co/auth/v1' })), /"iss" claim/],
    ['a wrong audience', () => sign(supabaseClaims({ aud: 'anon' })), /"aud" claim/],
    ['a missing email', () => sign(supabaseClaims({ email: undefined })), /JWT email claim is required/],
    ['an empty email (phone-only user)', () => sign(supabaseClaims({ email: '' })), /JWT email claim is required/],
    ['a missing sub', () => sign(supabaseClaims({ sub: undefined })), /JWT sub claim is required/],
    ['an empty sub', () => sign(supabaseClaims({ sub: '' })), /JWT sub claim is required/],
    ['a key not in the JWKS', () => sign(supabaseClaims(), otherPrivateKey), /signature verification failed/],
    [
      'an HS256 shared-secret token',
      () => sign(supabaseClaims(), new TextEncoder().encode('legacy-jwt-secret-legacy-jwt-secret'), 'HS256'),
      /Unsupported "alg" value for a JSON Web Key Set/,
    ],
  ])('rejects %s', async (_label, token, reason) => {
    const { request, error } = await run(await token());
    expect(error?.message).toMatch(reason);
    expect(request.user).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
  });

  it('rejects a request without a Bearer token with 401', async () => {
    const { error } = await run(null);
    expect(error?.status).toBe(401);
  });
});
