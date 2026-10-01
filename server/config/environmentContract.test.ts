import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateEnvironment, type Scope, type Target } from './environmentContract.js';

// Synthetic values only: example.com and made-up project refs; no real credentials.
const STAGING_REF = 'stagingrefaaaaaaaaaa';
const PRODUCTION_REF = 'prodrefbbbbbbbbbbbbb';

function deployedEnv(target: 'staging' | 'production') {
  const ref = target === 'staging' ? STAGING_REF : PRODUCTION_REF;
  const [frontendHost, apiHost] = target === 'staging' ? ['staging', 'api-staging'] : ['app', 'api'];
  return {
    frontend: {
      NODE_VERSION: '24',
      VITE_API_BASE_URL: `https://${apiHost}.example.com/api/v1`,
      VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_test_key',
    },
    api: {
      NODE_ENV: 'production',
      NODE_VERSION: '24',
      API_PORT: '10000',
      CORS_ORIGIN: `https://${frontendHost}.example.com`,
      DATABASE_URL: `postgresql://bizcaiaos_app.${ref}:synthetic-password@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
      DATABASE_SSL: 'require',
      AUTH_ISSUER: `https://${ref}.supabase.co/auth/v1`,
      AUTH_AUDIENCE: 'authenticated',
      AUTH_JWKS_URL: `https://${ref}.supabase.co/auth/v1/.well-known/jwks.json`,
      DOCUMENT_STORAGE_PROVIDER: 'local',
      DOCUMENT_STORAGE_LOCAL_ROOT: '/var/data/documents',
    },
    migration: {
      DATABASE_MIGRATE_URL: `postgresql://bizcaiaos_migrator.${ref}:synthetic-password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require`,
      POSTGRES_APP_USER: 'bizcaiaos_app',
    },
  };
}

const check = (env: Record<string, string | undefined>, target: Target, scopes: Scope[]) =>
  validateEnvironment(env, { target, scopes });
const errorsFor = (env: Record<string, string | undefined>, target: Target, scopes: Scope[]) =>
  check(env, target, scopes).filter((finding) => finding.level === 'error').map((finding) => finding.variable);

function parseTemplate(file: string) {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', file);
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

describe('environment contract', () => {
  it.each(['staging', 'production'] as const)('accepts a complete %s configuration', (target) => {
    const env = deployedEnv(target);
    expect(check({ ...env.frontend, ...env.api }, target, ['frontend', 'api'])).toEqual([]);
    expect(check(env.migration, target, ['migration'])).toEqual([]);
  });

  it('accepts an empty local configuration (demo mode) with warnings only', () => {
    const findings = check({}, 'local', ['frontend', 'api']);
    expect(findings.filter((finding) => finding.level === 'error')).toEqual([]);
    expect(findings.map((finding) => finding.variable)).toEqual(
      expect.arrayContaining(['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL', 'DATABASE_URL']),
    );
  });

  it('requires every deployed value', () => {
    expect(errorsFor({}, 'staging', ['frontend', 'api'])).toEqual(
      expect.arrayContaining([
        'VITE_API_BASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'NODE_ENV', 'API_PORT',
        'CORS_ORIGIN', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL', 'DATABASE_URL', 'DATABASE_SSL',
        'DOCUMENT_STORAGE_LOCAL_ROOT',
      ]),
    );
    expect(errorsFor({}, 'staging', ['migration'])).toEqual(['DATABASE_MIGRATE_URL']);
  });

  it.each([
    ['staging', 'production'],
    ['production', 'staging'],
  ] as const)('rejects %s configured with %s hosts (D-PROD-06)', (target, other) => {
    const env = deployedEnv(other);
    expect(errorsFor({ ...env.frontend, ...env.api }, target, ['frontend', 'api'])).toEqual(
      expect.arrayContaining(['VITE_API_BASE_URL', 'CORS_ORIGIN']),
    );
  });

  it('rejects a frontend and API wired to different Supabase projects', () => {
    const staging = deployedEnv('staging');
    const production = deployedEnv('production');
    const mixed = { ...staging.frontend, ...staging.api, AUTH_ISSUER: production.api.AUTH_ISSUER, AUTH_JWKS_URL: production.api.AUTH_JWKS_URL };
    expect(errorsFor(mixed, 'staging', ['frontend', 'api'])).toEqual(['AUTH_ISSUER']);
  });

  it('keeps secrets out of public VITE_ configuration', () => {
    const { frontend } = deployedEnv('staging');
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
    const servicePayload = Buffer.from('{"role":"service_role","iss":"supabase"}').toString('base64url');
    expect(errorsFor({ ...frontend, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_synthetic' }, 'staging', ['frontend'])).toEqual([
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ]);
    expect(
      errorsFor({ ...frontend, VITE_SUPABASE_PUBLISHABLE_KEY: `${header}.${servicePayload}.sig` }, 'staging', ['frontend']),
    ).toEqual(['VITE_SUPABASE_PUBLISHABLE_KEY']);
    expect(errorsFor({ ...frontend, VITE_SUPABASE_SERVICE_ROLE_KEY: 'x' }, 'staging', ['frontend'])).toEqual([
      'VITE_SUPABASE_SERVICE_ROLE_KEY',
    ]);
    expect(errorsFor({ ...frontend, VITE_EXTRA: 'postgresql://u:p@db.example.com/x' }, 'staging', ['frontend'])).toEqual([
      'VITE_EXTRA',
    ]);
  });

  it('enforces the API runtime rules', () => {
    const { api } = deployedEnv('production');
    expect(errorsFor({ ...api, CORS_ORIGIN: '*' }, 'production', ['api'])).toEqual(['CORS_ORIGIN']);
    expect(errorsFor({ ...api, CORS_ORIGIN: 'https://app.example.com/' }, 'production', ['api'])).toEqual(['CORS_ORIGIN']);
    expect(errorsFor({ ...api, CORS_ORIGIN: 'http://app.example.com' }, 'production', ['api'])).toEqual(['CORS_ORIGIN']);
    expect(errorsFor({ ...api, AUTH_AUDIENCE: 'anon' }, 'production', ['api'])).toEqual(['AUTH_AUDIENCE']);
    expect(errorsFor({ ...api, AUTH_JWKS_URL: 'https://other.supabase.co/auth/v1/.well-known/jwks.json' }, 'production', ['api'])).toEqual([
      'AUTH_JWKS_URL',
    ]);
    expect(errorsFor({ ...api, PORT: '10001' }, 'production', ['api'])).toEqual(['API_PORT']);
    expect(errorsFor({ ...api, NODE_ENV: 'test' }, 'production', ['api'])).toEqual(['NODE_ENV', 'NODE_ENV']);
    expect(errorsFor({ ...api, DATABASE_SSL: '' }, 'production', ['api'])).toEqual(['DATABASE_SSL']);
    expect(errorsFor({ ...api, DOCUMENT_STORAGE_LOCAL_ROOT: './.data/documents' }, 'production', ['api'])).toEqual([
      'DOCUMENT_STORAGE_LOCAL_ROOT',
    ]);
    expect(errorsFor({ ...api, DOCUMENT_STORAGE_PROVIDER: 's3' }, 'production', ['api'])).toEqual(['DOCUMENT_STORAGE_PROVIDER']);
  });

  it('keeps the API on the application role and migration credentials off the API service', () => {
    const { api, migration } = deployedEnv('production');
    expect(errorsFor({ ...api, DATABASE_URL: migration.DATABASE_MIGRATE_URL }, 'production', ['api'])).toEqual(['DATABASE_URL']);
    expect(
      errorsFor({ ...api, DATABASE_URL: 'postgresql://postgres:synthetic@db.prodrefbbbbbbbbbbbbb.supabase.co:5432/postgres' }, 'production', ['api']),
    ).toEqual(['DATABASE_URL']);
    expect(errorsFor({ ...api, ...migration }, 'production', ['api'])).toEqual(['DATABASE_MIGRATE_URL']);
    expect(errorsFor({ ...api, POSTGRES_APP_PASSWORD: 'synthetic' }, 'production', ['api'])).toEqual(['POSTGRES_APP_PASSWORD']);
  });

  it('enforces the migration connection rules (C-02 runner)', () => {
    const { migration } = deployedEnv('staging');
    const url = new URL(migration.DATABASE_MIGRATE_URL);
    const variant = (change: (copy: URL) => void) => {
      const copy = new URL(url);
      change(copy);
      return { ...migration, DATABASE_MIGRATE_URL: copy.toString() };
    };
    expect(errorsFor(variant((copy) => (copy.port = '6543')), 'staging', ['migration'])).toEqual(['DATABASE_MIGRATE_URL']);
    expect(errorsFor(variant((copy) => copy.searchParams.delete('sslmode')), 'staging', ['migration'])).toEqual(['DATABASE_MIGRATE_URL']);
    expect(errorsFor(variant((copy) => (copy.username = `postgres.${STAGING_REF}`)), 'staging', ['migration'])).toEqual([
      'DATABASE_MIGRATE_URL',
    ]);
  });

  it('never includes a configured value in its findings', () => {
    const { api } = deployedEnv('production');
    const leaky = { ...api, DATABASE_URL: 'postgresql://postgres:do-not-print-me@localhost:5432/x', DATABASE_MIGRATE_URL: 'do-not-print-me-either' };
    const text = JSON.stringify(check(leaky, 'production', ['api', 'migration']));
    expect(text).not.toContain('do-not-print-me');
  });

  it.each([
    ['staging.env.example', 'staging'],
    ['production.env.example', 'production'],
  ] as const)('%s holds placeholders only and cannot pass until filled in', (file, target) => {
    const env = parseTemplate(file);
    for (const [name, raw] of Object.entries(env)) {
      if (['DATABASE_URL', 'DATABASE_MIGRATE_URL'].includes(name)) expect(raw).toBe('<secret>');
      expect(raw).not.toMatch(/sb_secret_|sb_publishable_|eyJ[A-Za-z0-9_-]{10,}|postgres(ql)?:\/\//);
    }
    expect(errorsFor(env, target, ['frontend', 'api'])).toEqual(expect.arrayContaining(['VITE_API_BASE_URL', 'CORS_ORIGIN', 'DATABASE_URL']));
    expect(errorsFor(env, target, ['migration'])).toEqual(['DATABASE_MIGRATE_URL']);
  });
});
