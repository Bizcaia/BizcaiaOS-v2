import { describe, expect, it } from 'vitest';
import type { Check } from './checks.js';
import { configurationChecks, configurationNotSupplied, configurationSecrets, type DeployTarget } from './configuration.js';
import { DOMAIN, PASSWORD, POOLER, PROD_REF, STAGING_REF, syntheticConfig, toFile, type Config } from './syntheticConfig.fixture.js';

function edit(target: DeployTarget, change: (config: Config) => void) {
  const config = syntheticConfig(target);
  change(config);
  return toFile(config);
}

const failed = (checks: Check[]) => checks.filter((item) => item.status === 'FAIL').map((item) => item.id);
const evidence = (checks: Check[], id: string) => checks.find((item) => item.id === id)!.evidence.join('\n');

describe('R1 configuration checks (offline, synthetic)', () => {
  it('passes a clean staging and a clean production configuration', () => {
    for (const target of ['staging', 'production'] as const) {
      const checks = configurationChecks(toFile(syntheticConfig(target)), { target });
      expect(checks.map((item) => [item.id, item.status])).toEqual([
        ['R1-CFG-CONTRACT', 'VERIFIED'], ['R1-CFG-PROJECT', 'VERIFIED'], ['R1-CFG-ENVIRONMENT', 'VERIFIED'], ['R1-CFG-PUBLIC-SECRETS', 'VERIFIED'],
        ['R1-CFG-APP-ROLE', 'VERIFIED'], ['R1-CFG-API-TLS', 'VERIFIED'], ['R1-CFG-PRIVILEGED-CREDENTIALS', 'VERIFIED'], ['R1-CFG-MIGRATION-SEPARATION', 'VERIFIED'], ['R1-CFG-DATA-API', 'VERIFIED'],
      ]);
    }
  });

  it('detects a mismatched Supabase project (frontend vs API issuer, database)', () => {
    const checks = configurationChecks(edit('staging', (c) => {
      c.api.DATABASE_URL = c.api.DATABASE_URL.replace(`.${STAGING_REF}:`, `.${PROD_REF}:`);
    }), { target: 'staging' });
    expect(failed(checks)).toContain('R1-CFG-PROJECT');
    expect(evidence(checks, 'R1-CFG-PROJECT')).toContain('project #2: DATABASE_URL');
    const issuer = configurationChecks(edit('production', (c) => {
      c.frontend.VITE_SUPABASE_URL = 'https://otherrefcccccccccccc.supabase.co';
    }), { target: 'production' });
    expect(failed(issuer)).toEqual(expect.arrayContaining(['R1-CFG-CONTRACT', 'R1-CFG-PROJECT']));
  });

  it('detects staging configuration leaking into production', () => {
    const hosts = configurationChecks(edit('staging', (c) => {
      c.frontend.VITE_API_BASE_URL = `https://api.${DOMAIN}/api/v1`;
    }), { target: 'staging' });
    expect(evidence(hosts, 'R1-CFG-ENVIRONMENT')).toContain('[frontend] VITE_API_BASE_URL points at a production host');
    const project = configurationChecks(toFile(syntheticConfig('staging')), { target: 'staging', otherRef: STAGING_REF });
    expect(failed(project)).toContain('R1-CFG-ENVIRONMENT');
    expect(evidence(project, 'R1-CFG-ENVIRONMENT')).toContain("AUTH_ISSUER points at the other environment's Supabase project (--other-ref)");
  });

  it('detects production configuration leaking into staging', () => {
    const checks = configurationChecks(edit('production', (c) => {
      c.api.CORS_ORIGIN = `https://staging.${DOMAIN}`;
    }), { target: 'production' });
    expect(failed(checks)).toEqual(expect.arrayContaining(['R1-CFG-ENVIRONMENT']));
    expect(evidence(checks, 'R1-CFG-ENVIRONMENT')).toContain('[api] CORS_ORIGIN points at a staging host');
    expect(failed(configurationChecks(toFile(syntheticConfig('production')), { target: 'production', otherRef: PROD_REF }))).toContain('R1-CFG-ENVIRONMENT');
  });

  it('detects an incorrect application role, and the migration role used by the API', () => {
    const wrong = configurationChecks(edit('staging', (c) => {
      c.api.DATABASE_URL = c.api.DATABASE_URL.replace('bizcaiaos_app.', 'postgres.');
    }), { target: 'staging' });
    expect(evidence(wrong, 'R1-CFG-APP-ROLE')).toBe('[api] DATABASE_URL connects as postgres, not bizcaiaos_app');
    const migrator = configurationChecks(edit('staging', (c) => {
      c.api.DATABASE_URL = c.migration.DATABASE_MIGRATE_URL.split('?')[0];
    }), { target: 'staging' });
    expect(failed(migrator)).toEqual(expect.arrayContaining(['R1-CFG-APP-ROLE', 'R1-CFG-MIGRATION-SEPARATION']));
    expect(evidence(migrator, 'R1-CFG-APP-ROLE')).toBe('[api] DATABASE_URL connects as the migration role bizcaiaos_migrator');
    expect(evidence(migrator, 'R1-CFG-MIGRATION-SEPARATION')).toContain('DATABASE_URL and DATABASE_MIGRATE_URL use the same role');
  });

  it('detects migration credentials on the runtime API and the wrong migration connection', () => {
    const checks = configurationChecks(edit('production', (c) => {
      c.api.DATABASE_MIGRATE_URL = c.migration.DATABASE_MIGRATE_URL;
      c.migration.DATABASE_MIGRATE_URL = c.migration.DATABASE_MIGRATE_URL.replace(':5432/', ':6543/');
    }), { target: 'production' });
    expect(evidence(checks, 'R1-CFG-MIGRATION-SEPARATION')).toBe([
      '[api] DATABASE_MIGRATE_URL is migration/operator-only and must not be on a Render service',
      '[migration] DATABASE_MIGRATE_URL uses the transaction pooler (6543)',
    ].join('\n'));
  });

  it('detects the Data API configured as the application data path', () => {
    const checks = configurationChecks(edit('staging', (c) => {
      c.frontend.VITE_API_BASE_URL = `https://${STAGING_REF}.supabase.co/rest/v1`;
    }), { target: 'staging' });
    expect(failed(checks)).toContain('R1-CFG-DATA-API');
    expect(evidence(checks, 'R1-CFG-DATA-API')).toBe([
      '[frontend] VITE_API_BASE_URL targets a Supabase Data API, storage, realtime, or functions path',
      '[frontend] VITE_API_BASE_URL is a Supabase endpoint, not the BizcaiaOS API',
    ].join('\n'));
  });

  it('detects secrets in public frontend variables', () => {
    const checks = configurationChecks(edit('staging', (c) => {
      c.frontend.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_secret_synthetic';
      c.frontend.VITE_DB = c.api.DATABASE_URL;
      c.frontend.SUPABASE_SERVICE_ROLE_KEY = 'synthetic';
    }), { target: 'staging' });
    expect(evidence(checks, 'R1-CFG-PUBLIC-SECRETS')).toBe([
      'VITE_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret key',
      'VITE_DB holds a database connection string',
      'SUPABASE_SERVICE_ROLE_KEY is a secret-looking name on the public Static Site',
    ].join('\n'));
  });

  it('detects privileged credentials on the API runtime or in the migration session, for staging and production', () => {
    const serviceRoleJwt = ['e30', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'c2ln'].join('.');
    for (const target of ['staging', 'production'] as const) {
      const checks = configurationChecks(edit(target, (c) => {
        c.api.SUPABASE_SERVICE_ROLE_KEY = 'synthetic';
        c.api.SUPABASE_JWT_SECRET = 'synthetic';
        c.api.ANALYTICS_TOKEN = 'sb_secret_synthetic';
        c.api.EXTRA_KEY = serviceRoleJwt;
        c.migration.SIGNER = '-----BEGIN PRIVATE KEY-----synthetic';
      }), { target });
      expect(failed(checks), target).toContain('R1-CFG-PRIVILEGED-CREDENTIALS');
      expect(evidence(checks, 'R1-CFG-PRIVILEGED-CREDENTIALS')).toBe([
        '[api] SUPABASE_SERVICE_ROLE_KEY is a privileged credential BizcaiaOS does not use at runtime',
        '[api] SUPABASE_JWT_SECRET is a privileged credential BizcaiaOS does not use at runtime',
        '[api] ANALYTICS_TOKEN holds a Supabase secret key',
        '[api] EXTRA_KEY holds a service_role key',
        '[migration] SIGNER holds a private key',
      ].join('\n'));
    }
  });

  it('detects insecure API database transport for staging and production', () => {
    for (const target of ['staging', 'production'] as const) {
      for (const [parameter, expected] of [
        ['?sslmode=disable', '[api] DATABASE_URL sets sslmode=disable, which overrides DATABASE_SSL'],
        ['?sslmode=no-verify', '[api] DATABASE_URL sets sslmode=no-verify, which overrides DATABASE_SSL'],
        ['?ssl=0', '[api] DATABASE_URL sets ssl=0, which overrides DATABASE_SSL'],
        ['?uselibpqcompat=true&sslmode=require', '[api] DATABASE_URL sets uselibpqcompat=true without sslmode=verify-full, which overrides DATABASE_SSL'],
      ]) {
        const checks = configurationChecks(edit(target, (c) => {
          c.api.DATABASE_URL += parameter;
        }), { target });
        expect(evidence(checks, 'R1-CFG-API-TLS'), `${target} ${parameter}`).toBe(expected);
      }
      const noSsl = configurationChecks(edit(target, (c) => {
        delete c.api.DATABASE_SSL;
      }), { target });
      expect(evidence(noSsl, 'R1-CFG-API-TLS')).toBe('[api] DATABASE_SSL is not "require"');
      expect(failed(configurationChecks(edit(target, (c) => {
        c.api.DATABASE_URL += '?sslmode=verify-full&sslrootcert=/etc/secrets/ca.crt';
      }), { target }))).toEqual([]);
    }
  });

  it('marks every configuration check NOT_VERIFIED when no file is supplied', () => {
    const checks = configurationNotSupplied();
    expect(checks).toHaveLength(9);
    expect(checks.every((item) => item.status === 'NOT_VERIFIED' && item.required)).toBe(true);
    expect(checks[0].evidence[0]).toContain('NOT_VERIFIED — CONFIGURATION_FILE_REQUIRED');
  });

  it('never puts a value in evidence, and lists the values that must be redacted', () => {
    const file = edit('staging', (c) => {
      c.api.DATABASE_URL = c.api.DATABASE_URL.replace(`.${STAGING_REF}:`, `.${PROD_REF}:`);
      c.frontend.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_secret_synthetic_value';
    });
    const text = JSON.stringify(configurationChecks(file, { target: 'staging', otherRef: STAGING_REF }));
    for (const value of [PASSWORD, 'sb_secret_synthetic_value', STAGING_REF, PROD_REF, DOMAIN, POOLER]) expect(text).not.toContain(value);
    expect(configurationSecrets(file)).toEqual(expect.arrayContaining([PASSWORD, 'sb_secret_synthetic_value']));
    expect(configurationSecrets(file.replaceAll(PASSWORD, 'PASSWORD'))).not.toContain('PASSWORD');
  });
});
