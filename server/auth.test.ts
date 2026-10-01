import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { errors, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// C-01: real jose verification of Supabase Auth-shaped access tokens against a
// local JWKS. No Supabase project is involved; keys are generated per run.
// The database is mocked: `sync` is the identity sync in authenticate, and
// `actor` stands in for the route's RLS-scoped transaction.
const sync = vi.hoisted(() => vi.fn());
const actor = vi.hoisted(() => vi.fn());
vi.mock('./database.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: vi.fn(async (operation: (client: { query: typeof sync }) => Promise<unknown>) =>
    operation({ query: sync }),
  ),
  withActorTransaction: actor,
  firstRow: vi.fn(),
}));

import { authenticate, isTokenRejection } from './auth.js';

const { app } = await import('./index.js');

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

/** Correctly signed by the JWKS key, but expired five minutes ago. */
function signExpired(claims: JWTPayload) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' }).setIssuedAt(now - 600).setExpirationTime(now - 300).sign(privateKey);
}

/** A validly signed token whose payload was swapped afterwards: the signature no longer matches. */
async function tampered() {
  const [header, , signature] = (await sign(supabaseClaims())).split('.');
  const payload = Buffer.from(JSON.stringify(supabaseClaims({ sub: 'someone-else' }))).toString('base64url');
  return [header, payload, signature].join('.');
}

/** Rejections that come from the presented token itself; each must be a 401. */
const invalidTokens: Array<[string, () => Promise<string> | string, RegExp]> = [
  ['a malformed token (not a JWT)', () => 'not-a-jwt', /Invalid Compact JWS/],
  ['a malformed token (three garbage segments)', () => 'aaa.bbb.ccc', /JWS Protected Header is invalid|Invalid/],
  ['a tampered payload (invalid signature)', tampered, /signature verification failed/],
  ['a key not in the JWKS', () => sign(supabaseClaims(), otherPrivateKey), /signature verification failed/],
  ['an expired token', () => signExpired(supabaseClaims()), /"exp" claim timestamp check failed/],
  ['a wrong issuer', () => sign(supabaseClaims({ iss: 'https://other-project.supabase.co/auth/v1' })), /"iss" claim/],
  ['a wrong audience', () => sign(supabaseClaims({ aud: 'anon' })), /"aud" claim/],
  [
    'an HS256 shared-secret token',
    () => sign(supabaseClaims(), new TextEncoder().encode('legacy-jwt-secret-legacy-jwt-secret'), 'HS256'),
    /Unsupported "alg" value for a JSON Web Key Set/,
  ],
];

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
    ...invalidTokens,
    ['a missing email', () => sign(supabaseClaims({ email: undefined })), /JWT email claim is required/],
    ['an empty email (phone-only user)', () => sign(supabaseClaims({ email: '' })), /JWT email claim is required/],
    ['a missing sub', () => sign(supabaseClaims({ sub: undefined })), /JWT sub claim is required/],
    ['an empty sub', () => sign(supabaseClaims({ sub: '' })), /JWT sub claim is required/],
  ] as Array<[string, () => Promise<string> | string, RegExp]>)('rejects %s with 401', async (_label, token, reason) => {
    const { request, error } = await run(await token());
    expect(error?.status).toBe(401);
    // jose's specific reason is kept as the cause for diagnostics; it never reaches the response.
    expect((error?.cause as Error | undefined)?.message ?? error?.message).toMatch(reason);
    expect(request.user).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
  });

  it('rejects a request without a Bearer token with 401', async () => {
    const { error } = await run(null);
    expect(error?.status).toBe(401);
  });
});

// Through the real Express app and its error handler: what a client receives.
describe('HTTP status for authentication outcomes (real app, real jose, local JWKS)', () => {
  let api: Server;
  let base: string;

  beforeAll(async () => {
    api = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => api.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  beforeEach(() => {
    actor.mockReset();
  });

  async function get(path: string, token: string | null) {
    const response = await fetch(`${base}${path}`, { headers: token === null ? {} : { Authorization: `Bearer ${token}` } });
    return { status: response.status, text: await response.text() };
  }

  it.each(invalidTokens)('%s returns 401, never 500, without leaking the token or verification details', async (_label, make) => {
    const token = await make();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { status, text } = await get('/me', token);
      expect(status).toBe(401);
      expect(JSON.parse(text)).toEqual({ error: { code: 'unauthorized', message: 'Invalid or expired access token' } });
      expect(text).not.toContain(token);
      expect(text).not.toMatch(/ERR_J|claim|signature|alg/i);
      // A rejected credential is not a server error: nothing is logged, so no token reaches the logs.
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    expect(sync).not.toHaveBeenCalled();
    expect(actor).not.toHaveBeenCalled();
  });

  it('a missing token keeps its existing 401 response', async () => {
    const { status, text } = await get('/me', null);
    expect(status).toBe(401);
    expect(JSON.parse(text)).toEqual({ error: { code: 'unauthorized', message: 'Bearer token is required' } });
  });

  it('a valid token keeps its existing success response', async () => {
    actor.mockResolvedValue([{ id: 'org-1', name: 'Org A', role: 'owner' }]);
    const { status, text } = await get('/me', await sign(supabaseClaims()));
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      data: { id: 'app-user-1', email: 'user@example.com', displayName: 'user@example.com', organizations: [{ id: 'org-1', name: 'Org A', role: 'owner' }] },
    });
    expect(actor).toHaveBeenCalledWith('app-user-1', expect.any(Function));
  });

  it('a valid token without the required authorization keeps its existing 403 response', async () => {
    actor.mockRejectedValue(Object.assign(new Error('permission denied for table organizations'), { code: '42501' }));
    const { status, text } = await get('/me', await sign(supabaseClaims()));
    expect(status).toBe(403);
    expect(JSON.parse(text)).toEqual({ error: { code: '42501', message: 'permission denied for table organizations' } });
  });
});

describe('isTokenRejection', () => {
  it('classifies token-caused jose errors as rejections and leaves server-side failures alone', () => {
    for (const error of [
      new errors.JWSInvalid('x'),
      new errors.JWTInvalid('x'),
      new errors.JWSSignatureVerificationFailed(),
      new errors.JWTExpired('x', {}),
      new errors.JWTClaimValidationFailed('x', {}),
      new errors.JOSEAlgNotAllowed('x'),
      new errors.JOSENotSupported('x'),
      new errors.JWKSNoMatchingKey(),
      new errors.JWKSMultipleMatchingKeys(),
    ]) {
      expect(isTokenRejection(error), error.code).toBe(true);
    }
    // JWKS retrieval problems are the server's, not the client's: they stay 5xx.
    for (const error of [new errors.JWKSTimeout(), new errors.JWKSInvalid('x'), new Error('socket hang up'), Object.assign(new Error('db'), { code: '42501' })]) {
      expect(isTokenRejection(error)).toBe(false);
    }
  });
});
