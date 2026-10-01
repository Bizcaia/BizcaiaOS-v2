import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSectionedEnv, runPreflight, stagingPreflight, type Section } from './stagingPreflight.js';

// Synthetic values only: no real project, domain, key, or password.
const REF = 'stagingrefaaaaaaaaaa';
const PROD_REF = 'prodrefbbbbbbbbbbbbb';
const DOMAIN = 'bizcaiaos-synthetic.test';
const PASSWORD = 'synthetic-password-never-printed';
const POOLER = 'aws-0-ap-southeast-1.pooler.supabase.com';

type Config = Record<Section, Record<string, string>>;

function readyConfig(): Config {
  return {
    frontend: {
      NODE_VERSION: '24',
      VITE_API_BASE_URL: `https://api-staging.${DOMAIN}/api/v1`,
      VITE_SUPABASE_URL: `https://${REF}.supabase.co`,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
    },
    api: {
      NODE_ENV: 'production',
      NODE_VERSION: '24',
      API_PORT: '10000',
      CORS_ORIGIN: `https://staging.${DOMAIN}`,
      DATABASE_URL: `postgresql://bizcaiaos_app.${REF}:${PASSWORD}@${POOLER}:5432/postgres`,
      DATABASE_SSL: 'require',
      AUTH_ISSUER: `https://${REF}.supabase.co/auth/v1`,
      AUTH_AUDIENCE: 'authenticated',
      AUTH_JWKS_URL: `https://${REF}.supabase.co/auth/v1/.well-known/jwks.json`,
      DOCUMENT_STORAGE_PROVIDER: 'local',
      DOCUMENT_STORAGE_LOCAL_ROOT: '/var/data/documents',
    },
    migration: {
      DATABASE_MIGRATE_URL: `postgresql://bizcaiaos_migrator.${REF}:${PASSWORD}@${POOLER}:5432/postgres?sslmode=require`,
      POSTGRES_APP_USER: 'bizcaiaos_app',
    },
  };
}

function toFile(config: Config) {
  const block = (header: string, env: Record<string, string>) => [header, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)].join('\n');
  return [
    '# synthetic staging configuration',
    block('# --- Frontend: Render Static Site ---', config.frontend),
    block('# --- API: Render Web Service ---', config.api),
    block('# --- Migration: operator session only ---', config.migration),
  ].join('\n\n');
}

function edit(change: (config: Config) => void) {
  const config = readyConfig();
  change(config);
  return config;
}

const errorsOf = (config: Config, options: { productionRef?: string } = {}) =>
  stagingPreflight(config, options)
    .filter((finding) => finding.level === 'error')
    .map((finding) => `[${finding.section}] ${finding.variable}`);

function cli(contents: string, extra: string[] = []) {
  const lines: string[] = [];
  const code = runPreflight(['--env-file', 'staging.env', ...extra], () => contents, (line) => lines.push(line));
  return { code, output: lines.join('\n') };
}

describe('staging provisioning preflight', () => {
  it('passes a complete, consistent synthetic staging configuration', () => {
    expect(stagingPreflight(readyConfig())).toEqual([]);
    const { code, output } = cli(toFile(readyConfig()));
    expect(code).toBe(0);
    expect(output).toContain('staging preflight: READY');
  });

  it('accepts a password stand-in, so the checked file need hold no secret', () => {
    const config = edit((c) => {
      c.api.DATABASE_URL = c.api.DATABASE_URL.replace(PASSWORD, 'PASSWORD');
      c.migration.DATABASE_MIGRATE_URL = c.migration.DATABASE_MIGRATE_URL.replace(PASSWORD, 'PASSWORD');
    });
    expect(errorsOf(config)).toEqual([]);
  });

  it('reports the unfilled repository template as not ready', () => {
    const template = readFileSync(resolve(__dirname, '../../deploy/staging.env.example'), 'utf8');
    const parsed = parseSectionedEnv(template);
    expect(parsed.findings).toEqual([]);
    expect(Object.keys(parsed.sections.migration)).toEqual(['DATABASE_MIGRATE_URL', 'POSTGRES_APP_USER']);
    const { code, output } = cli(template);
    expect(code).toBe(1);
    expect(output).toContain('[api] DATABASE_URL: is still a template placeholder');
    expect(output).toContain('[frontend] VITE_SUPABASE_PUBLISHABLE_KEY: is still a template placeholder');
    expect(output).toContain('NOT READY');
  });

  it('reports missing required variables', () => {
    const config = edit((c) => {
      delete c.frontend.VITE_SUPABASE_URL;
      delete c.api.AUTH_JWKS_URL;
      delete c.api.NODE_VERSION;
      delete c.migration.DATABASE_MIGRATE_URL;
    });
    expect(errorsOf(config)).toEqual(
      expect.arrayContaining(['[frontend] VITE_SUPABASE_URL', '[api] AUTH_JWKS_URL', '[api] NODE_VERSION', '[migration] DATABASE_MIGRATE_URL']),
    );
  });

  it('reports a missing section header and variables outside a section', () => {
    const parsed = parseSectionedEnv(`VITE_API_BASE_URL=https://api-staging.${DOMAIN}/api/v1\n# --- API ---\nAPI_PORT=10000`);
    expect(parsed.findings.map((finding) => `${finding.section}:${finding.variable}`)).toEqual([
      'file:VITE_API_BASE_URL',
      'file:frontend',
      'file:migration',
    ]);
  });

  it('reports staging/production confusion', () => {
    expect(errorsOf(readyConfig(), { productionRef: REF })).toEqual([
      '[frontend] VITE_SUPABASE_URL',
      '[api] AUTH_ISSUER',
      '[api] DATABASE_URL',
      '[migration] DATABASE_MIGRATE_URL',
    ]);
    expect(errorsOf(readyConfig(), { productionRef: PROD_REF })).toEqual([]);
    const productionHosts = edit((c) => {
      c.frontend.VITE_API_BASE_URL = `https://api.${DOMAIN}/api/v1`;
      c.api.CORS_ORIGIN = `https://app.${DOMAIN}`;
    });
    expect(errorsOf(productionHosts)).toEqual(expect.arrayContaining(['[frontend] VITE_API_BASE_URL', '[api] CORS_ORIGIN']));
  });

  it('reports mismatched Supabase project references', () => {
    const database = edit((c) => {
      c.api.DATABASE_URL = c.api.DATABASE_URL.replace(`.${REF}:`, `.${PROD_REF}:`);
    });
    expect(errorsOf(database)).toContain('[api] DATABASE_URL');
    const migration = edit((c) => {
      c.migration.DATABASE_MIGRATE_URL = `postgresql://bizcaiaos_migrator:${PASSWORD}@db.${PROD_REF}.supabase.co:5432/postgres?sslmode=require`;
    });
    expect(errorsOf(migration)).toContain('[migration] DATABASE_MIGRATE_URL');
    const frontend = edit((c) => {
      c.frontend.VITE_SUPABASE_URL = `https://${PROD_REF}.supabase.co`;
    });
    expect(errorsOf(frontend)).toContain('[frontend] VITE_SUPABASE_URL');
  });

  it('reports a database that is not the Supabase staging project', () => {
    const config = edit((c) => {
      c.api.DATABASE_URL = `postgresql://bizcaiaos_app:${PASSWORD}@db.elsewhere.example.test:5432/postgres`;
    });
    expect(errorsOf(config)).toEqual(['[api] DATABASE_URL']);
  });

  it('reports wrong hostnames and a missing or inconsistent staging domain', () => {
    const mismatch = edit((c) => {
      c.frontend.VITE_API_BASE_URL = 'https://api-staging.other-synthetic.test/api/v1';
    });
    expect(errorsOf(mismatch)).toEqual(['[frontend] VITE_API_BASE_URL']);
    const noDomain = edit((c) => {
      c.api.CORS_ORIGIN = 'https://staging.internal';
      c.frontend.VITE_API_BASE_URL = 'https://api-staging.internal/api/v1';
    });
    expect(errorsOf(noDomain)).toEqual(['[api] CORS_ORIGIN', '[frontend] VITE_API_BASE_URL']);
  });

  it('reports public secret exposure', () => {
    const secretKey = edit((c) => {
      c.frontend.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_secret_synthetic';
    });
    expect(errorsOf(secretKey)).toEqual(['[frontend] VITE_SUPABASE_PUBLISHABLE_KEY']);
    const databaseOnStaticSite = edit((c) => {
      c.frontend.DATABASE_URL = c.api.DATABASE_URL;
    });
    expect(errorsOf(databaseOnStaticSite)).toEqual(['[frontend] DATABASE_URL']);
    const serviceRole = edit((c) => {
      c.api.SUPABASE_SERVICE_ROLE_KEY = 'synthetic';
    });
    expect(errorsOf(serviceRole)).toEqual(['[api] SUPABASE_SERVICE_ROLE_KEY']);
  });

  it('reports the wrong database role on either connection', () => {
    const api = edit((c) => {
      c.api.DATABASE_URL = c.api.DATABASE_URL.replace('bizcaiaos_app.', 'postgres.');
    });
    expect(errorsOf(api)).toEqual(['[api] DATABASE_URL']);
    const migration = edit((c) => {
      c.migration.DATABASE_MIGRATE_URL = c.migration.DATABASE_MIGRATE_URL.replace('bizcaiaos_migrator.', 'bizcaiaos_app.');
    });
    expect(errorsOf(migration)).toEqual(['[migration] DATABASE_MIGRATE_URL']);
  });

  it('reports migration credentials on the API service and local-only passwords', () => {
    const config = edit((c) => {
      c.api.DATABASE_MIGRATE_URL = c.migration.DATABASE_MIGRATE_URL;
      c.migration.POSTGRES_APP_PASSWORD = 'synthetic';
    });
    expect(errorsOf(config)).toEqual(
      expect.arrayContaining(['[api] DATABASE_MIGRATE_URL', '[migration] POSTGRES_APP_PASSWORD']),
    );
  });

  it('reports the transaction pooler port for migrations', () => {
    const config = edit((c) => {
      c.migration.DATABASE_MIGRATE_URL = c.migration.DATABASE_MIGRATE_URL.replace(':5432/', ':6543/');
    });
    expect(errorsOf(config)).toEqual(['[migration] DATABASE_MIGRATE_URL']);
  });

  it('reports missing or disabled TLS', () => {
    const apiSsl = edit((c) => {
      delete c.api.DATABASE_SSL;
    });
    expect(errorsOf(apiSsl)).toEqual(['[api] DATABASE_SSL']);
    const urlOverride = edit((c) => {
      c.api.DATABASE_URL += '?sslmode=no-verify';
    });
    expect(errorsOf(urlOverride)).toEqual(['[api] DATABASE_URL']);
    const migration = edit((c) => {
      c.migration.DATABASE_MIGRATE_URL = c.migration.DATABASE_MIGRATE_URL.replace('?sslmode=require', '');
    });
    expect(errorsOf(migration)).toEqual(['[migration] DATABASE_MIGRATE_URL']);
  });

  it('reports invalid CORS', () => {
    for (const origin of ['*', `https://staging.${DOMAIN}/`, `http://staging.${DOMAIN}`, `https://staging.${DOMAIN},https://other.test`]) {
      const config = edit((c) => {
        c.api.CORS_ORIGIN = origin;
      });
      expect(errorsOf(config)).toContain('[api] CORS_ORIGIN');
    }
  });

  it('reports an invalid Auth issuer / JWKS relationship', () => {
    const jwks = edit((c) => {
      c.api.AUTH_JWKS_URL = `https://${REF}.supabase.co/.well-known/jwks.json`;
    });
    expect(errorsOf(jwks)).toEqual(['[api] AUTH_JWKS_URL']);
    const issuer = edit((c) => {
      c.api.AUTH_ISSUER = `https://${REF}.supabase.co/auth/v1/`;
      c.api.AUTH_JWKS_URL = `https://${REF}.supabase.co/auth/v1/.well-known/jwks.json`;
    });
    expect(errorsOf(issuer)).toEqual(['[api] AUTH_ISSUER']);
  });

  it('reports names the application never reads and variables in the wrong section', () => {
    const config = edit((c) => {
      c.frontend.VITE_SUPABASE_ANON_KEY = c.frontend.VITE_SUPABASE_PUBLISHABLE_KEY;
      c.api.DOCUMENT_ROOT = '/var/data/documents';
      c.api.VITE_API_BASE_URL = c.frontend.VITE_API_BASE_URL;
    });
    expect(errorsOf(config)).toEqual(['[frontend] VITE_SUPABASE_ANON_KEY', '[api] DOCUMENT_ROOT', '[api] VITE_API_BASE_URL']);
  });

  it('reports Render port and persistent disk mistakes', () => {
    const port = edit((c) => {
      c.api.API_PORT = '8787';
    });
    expect(errorsOf(port)).toEqual(['[api] API_PORT']);
    const customPort = edit((c) => {
      c.api.API_PORT = '8080';
      c.api.PORT = '8080';
    });
    expect(errorsOf(customPort)).toEqual([]);
    const disk = edit((c) => {
      c.api.DOCUMENT_STORAGE_LOCAL_ROOT = '/srv/documents';
    });
    expect(errorsOf(disk)).toEqual(['[api] DOCUMENT_STORAGE_LOCAL_ROOT']);
  });

  it('never prints a value', () => {
    const config = edit((c) => {
      c.api.DATABASE_URL = c.api.DATABASE_URL.replace(`.${REF}:`, `.${PROD_REF}:`) + '?sslmode=disable';
      c.migration.DATABASE_MIGRATE_URL = c.migration.DATABASE_MIGRATE_URL.replace(':5432/', ':6543/');
      c.frontend.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_secret_synthetic_value';
    });
    const { code, output } = cli(toFile(config), ['--production-ref', REF]);
    expect(code).toBe(1);
    for (const value of [PASSWORD, 'sb_secret_synthetic_value', REF, PROD_REF, DOMAIN, POOLER]) {
      expect(output).not.toContain(value);
    }
  });

  it('exits 2 on usage errors', () => {
    const log: string[] = [];
    expect(runPreflight([], () => '', (line) => log.push(line))).toBe(2);
    expect(runPreflight(['--env-file'], () => '', (line) => log.push(line))).toBe(2);
    expect(runPreflight(['--env-file', 'x', '--target', 'production'], () => '', (line) => log.push(line))).toBe(2);
    expect(runPreflight(['--env-file', 'missing'], () => { throw new Error('ENOENT'); }, (line) => log.push(line))).toBe(2);
    expect(log.join('\n')).toContain('Usage: npm run staging:preflight');
  });
});
