import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.AUTH_JWKS_URL = 'https://example.invalid/.well-known/jwks.json';
process.env.AUTH_ISSUER = 'https://example.invalid';
process.env.AUTH_AUDIENCE = 'bizcaiaos-api';

const poolQuery = vi.fn();
const transactionQuery = vi.fn();

vi.mock('./database.js', () => ({
  pool: { query: poolQuery },
  withTransaction: vi.fn(async (operation: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
    operation({ query: transactionQuery }),
  ),
  withActorTransaction: vi.fn(),
  firstRow: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => {
    // A JWKS retrieval failure: the server's problem, so it stays a 5xx.
    if (token === 'jwks-timeout-token') {
      throw Object.assign(new Error('timed out fetching the JWKS'), { code: 'ERR_JWKS_TIMEOUT' });
    }
    if (token !== 'valid-test-token') {
      throw new Error('invalid token');
    }
    return {
      payload: {
        sub: 'auth0|test-user',
        email: 'test@example.com',
        name: 'Test User',
      },
    };
  }),
}));

const { app } = await import('./index.js');

async function withApi(run: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('API foundation', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test';
  });

  beforeEach(() => {
    poolQuery.mockReset();
    transactionQuery.mockReset();
    transactionQuery.mockResolvedValue({
      rows: [{ user_id: '11111111-1111-4111-8111-111111111111' }],
    });
  });

  afterAll(() => {
    poolQuery.mockReset();
    transactionQuery.mockReset();
  });

  it('returns ok from GET /health when the database ping succeeds', async () => {
    poolQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      await expect(response.json()).resolves.toEqual({ status: 'ok' });
      expect(response.status).toBe(200);
      expect(poolQuery).toHaveBeenCalledWith('select 1');
    });
  });

  it('rejects an unauthenticated API request before reaching a protected handler', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/me`);
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body).toEqual({
        error: {
          code: 'unauthorized',
          message: 'Bearer token is required',
        },
      });
      expect(transactionQuery).not.toHaveBeenCalled();
    });
  });

  it('validates organization onboarding payloads after authentication', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/organizations/onboard`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.error.code).toBe('validation_error');
      expect(body.error.message).toBe('Request validation failed');
      expect(transactionQuery).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses an unknown request-body key with 400 validation_error before onboarding anything', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/organizations/onboard`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Valid Org', slug: 'valid-org', timezone: 'Asia/Manila', plan: 'enterprise' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['plan'], path: [] })],
        },
      });
      // Only the signed-in user sync ran; bootstrap_organization was never called.
      expect(transactionQuery).toHaveBeenCalledTimes(1);
    });
  });
});

describe('error responses', () => {
  const INTERNAL = { error: { code: 'internal_server_error', message: 'An internal server error occurred' } };
  const AUTH = { Authorization: 'Bearer valid-test-token' };

  beforeEach(() => {
    poolQuery.mockReset();
    transactionQuery.mockReset();
  });

  it.each([
    ['an unmapped PostgreSQL code (foreign-key violation)', '23503'],
    ['a PostgreSQL statement timeout', '57014'],
    ['a PostgreSQL connection limit', '53300'],
    ['a Node network error', 'ECONNREFUSED'],
    ['a file-system error', 'ENOENT'],
  ])('a 5xx from %s returns one stable public code, never the internal one', async (_label, internalCode) => {
    poolQuery.mockRejectedValue(Object.assign(new Error(`internal detail for ${internalCode}`), { code: internalCode }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/health`);
        const text = await response.text();
        expect(response.status).toBe(500);
        expect(JSON.parse(text)).toEqual(INTERNAL);
        expect(text).not.toContain(internalCode);
        expect(text).not.toContain('internal detail');
      });
      // The full error, including its code, still reaches the server log.
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ code: internalCode }));
    } finally {
      logged.mockRestore();
    }
  });

  it('a 5xx from an error with no code uses the same public code', async () => {
    poolQuery.mockRejectedValue(new Error('socket hang up'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/health`);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual(INTERNAL);
      });
    } finally {
      logged.mockRestore();
    }
  });

  it('a JWKS retrieval failure during authentication returns 500 without its JOSE code', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/me`, { headers: { Authorization: 'Bearer jwks-timeout-token' } });
        const text = await response.text();
        expect(response.status).toBe(500);
        expect(JSON.parse(text)).toEqual(INTERNAL);
        expect(text).not.toContain('ERR_JWKS');
      });
      expect(transactionQuery).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('a database failure while synchronizing the signed-in user returns 500 without its code', async () => {
    transactionQuery.mockRejectedValue(Object.assign(new Error('could not connect'), { code: '08006' }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/me`, { headers: AUTH });
        const text = await response.text();
        expect(response.status).toBe(500);
        expect(JSON.parse(text)).toEqual(INTERNAL);
        expect(text).not.toContain('08006');
      });
    } finally {
      logged.mockRestore();
    }
  });

  it('a missing auth configuration (503) uses the same public code', async () => {
    const issuer = process.env.AUTH_ISSUER;
    delete process.env.AUTH_ISSUER;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/me`, { headers: AUTH });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual(INTERNAL);
      });
    } finally {
      process.env.AUTH_ISSUER = issuer;
      logged.mockRestore();
    }
  });

  // Unchanged 4xx contract: mapped database codes keep their code and message.
  it.each([
    ['42501', 403, 'permission denied for table organizations'],
    ['23505', 409, 'duplicate key value violates unique constraint "projects_code_key"'],
    ['23514', 422, 'new row violates check constraint "properties_risk_check"'],
    ['22023', 422, 'A reason is required'],
    ['P0002', 404, 'Property not found'],
  ])('a mapped database code %s still returns %i with its code and message', async (code, status, message) => {
    poolQuery.mockRejectedValue(Object.assign(new Error(message), { code }));
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code, message } });
    });
  });

  it('a stale lifecycle value still returns 409 lifecycle_conflict with its details', async () => {
    poolQuery.mockRejectedValue(Object.assign(new Error('The record changed since it was loaded'), {
      code: '40001',
      detail: JSON.stringify({ field: 'acquisition_stage', current: 'negotiation', expected: 'identified' }),
    }));
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: 'lifecycle_conflict',
          message: 'The record changed since it was loaded',
          details: { field: 'acquisition_stage', current: 'negotiation', expected: 'identified' },
        },
      });
    });
  });

  it('an explicit 4xx without a code keeps its derived code and message', async () => {
    poolQuery.mockRejectedValue(Object.assign(new Error('Not allowed here'), { status: 403 }));
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: 'forbidden', message: 'Not allowed here' } });
    });
    poolQuery.mockRejectedValue(Object.assign(new Error('Too large'), { status: 413 }));
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: { code: 'request_failed', message: 'Too large' } });
    });
  });
});
