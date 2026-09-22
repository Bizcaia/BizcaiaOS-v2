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
});
