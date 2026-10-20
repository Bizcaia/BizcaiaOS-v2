import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import '../loadEnv.js';
import { runMigrations } from '../migrate.js';
import { requireDatabaseEnv } from './postgresHarness.js';
import { PROPERTY_IMPORT_CSV_HEADERS } from '../../shared/propertyCsvContract.js';

process.env.NODE_ENV = 'test';
process.env.AUTH_JWKS_URL ??= 'https://example.invalid/.well-known/jwks.json';
process.env.AUTH_ISSUER ??= 'https://example.invalid';
process.env.AUTH_AUDIENCE ??= 'bizcaiaos-api';
process.env.PROPERTY_IMPORT_CSV_MAX_BYTES ??= '5242880';

const subject = `auth0|import-${randomUUID().slice(0, 8)}`;

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => {
    if (token !== 'valid-test-token') throw new Error('invalid token');
    return {
      payload: {
        sub: subject,
        email: `${subject.replace('|', '.')}@example.com`,
        name: 'Import Admin',
      },
    };
  }),
}));

const { app } = await import('../index.js');
const { pool } = await import('../database.js');

const auth = { Authorization: 'Bearer valid-test-token' };
const header = PROPERTY_IMPORT_CSV_HEADERS.join(',');
// pool is used for zero-write assertions only; do not end it (shared across integration files).

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

describe('property CSV import against PostgreSQL', () => {
  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
  }, 60_000);

  it('previews with zero writes and commits atomically', async () => {
    await withApi(async (baseUrl) => {
      const onboard = await fetch(`${baseUrl}/api/v1/organizations/onboard`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Import Org ${randomUUID().slice(0, 8)}`,
          slug: `import-org-${randomUUID().slice(0, 8)}`,
          timezone: 'Asia/Manila',
        }),
      });
      expect(onboard.status).toBe(201);
      const onboardBody = await onboard.json();
      const organizationId = onboardBody.organizationId ?? onboardBody.data?.organizationId;
      expect(organizationId).toBeTruthy();

      const project = await fetch(`${baseUrl}/api/v1/ops/projects`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, code: 'IMP-01', name: 'Import Project' }),
      });
      expect(project.status).toBe(201);

      const countBefore = await pool.query(`select count(*)::int as count from public.properties where organization_id = $1`, [
        organizationId,
      ]);

      const csv = `${header}\nIMP-01,IMP-REF-1,,,,,,,Calamba,medium\n`;
      const form = new FormData();
      form.set('organizationId', organizationId);
      form.set('file', new File([csv], 'ok.csv', { type: 'text/csv' }));

      const preview = await fetch(`${baseUrl}/api/v1/ops/imports/properties/preview`, { method: 'POST', headers: auth, body: form });
      expect(preview.status).toBe(200);
      const previewBody = await preview.json();
      expect(previewBody.data.canCommit).toBe(true);

      const countAfterPreview = await pool.query(`select count(*)::int as count from public.properties where organization_id = $1`, [
        organizationId,
      ]);
      expect(countAfterPreview.rows[0].count).toBe(countBefore.rows[0].count);

      const commitForm = new FormData();
      commitForm.set('organizationId', organizationId);
      commitForm.set('file', new File([csv], 'ok.csv', { type: 'text/csv' }));
      const commit = await fetch(`${baseUrl}/api/v1/ops/imports/properties/commit`, {
        method: 'POST',
        headers: auth,
        body: commitForm,
      });
      expect(commit.status).toBe(201);
      expect((await commit.json()).data.createdCount).toBe(1);

      const unknownProject = new FormData();
      unknownProject.set('organizationId', organizationId);
      unknownProject.set('file', new File([`${header}\nNO-SUCH,IMP-REF-2,,,,,,,,\n`], 'missing.csv', { type: 'text/csv' }));
      const missingPreview = await fetch(`${baseUrl}/api/v1/ops/imports/properties/preview`, {
        method: 'POST',
        headers: auth,
        body: unknownProject,
      });
      expect(missingPreview.status).toBe(200);
      const missingBody = await missingPreview.json();
      expect(missingBody.data.rows[0].errors.some((error: { code: string }) => error.code === 'PROJECT_NOT_FOUND')).toBe(true);
    });
  }, 60_000);
});
