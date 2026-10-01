/** Synthetic R1 test fixtures only: no real project, domain, key, or password. */
import type { DeployTarget } from './configuration.js';

export const STAGING_REF = 'stagingrefaaaaaaaaaa';
export const PROD_REF = 'prodrefbbbbbbbbbbbbb';
export const DOMAIN = 'bizcaiaos-synthetic.test';
export const PASSWORD = 'synthetic-password-never-printed';
export const POOLER = 'aws-0-ap-southeast-1.pooler.supabase.com';

export type Config = Record<'frontend' | 'api' | 'migration', Record<string, string>>;

export function syntheticConfig(target: DeployTarget = 'staging'): Config {
  const ref = target === 'staging' ? STAGING_REF : PROD_REF;
  const [frontendHost, apiHost] = target === 'staging' ? [`staging.${DOMAIN}`, `api-staging.${DOMAIN}`] : [`app.${DOMAIN}`, `api.${DOMAIN}`];
  return {
    frontend: {
      NODE_VERSION: '24',
      VITE_API_BASE_URL: `https://${apiHost}/api/v1`,
      VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
    },
    api: {
      NODE_ENV: 'production',
      NODE_VERSION: '24',
      API_PORT: '10000',
      CORS_ORIGIN: `https://${frontendHost}`,
      DATABASE_URL: `postgresql://bizcaiaos_app.${ref}:${PASSWORD}@${POOLER}:5432/postgres`,
      DATABASE_SSL: 'require',
      AUTH_ISSUER: `https://${ref}.supabase.co/auth/v1`,
      AUTH_AUDIENCE: 'authenticated',
      AUTH_JWKS_URL: `https://${ref}.supabase.co/auth/v1/.well-known/jwks.json`,
      DOCUMENT_STORAGE_PROVIDER: 'local',
      DOCUMENT_STORAGE_LOCAL_ROOT: '/var/data/documents',
    },
    migration: {
      DATABASE_MIGRATE_URL: `postgresql://bizcaiaos_migrator.${ref}:${PASSWORD}@${POOLER}:5432/postgres?sslmode=require`,
      POSTGRES_APP_USER: 'bizcaiaos_app',
    },
  };
}

export function toFile(config: Config) {
  const block = (header: string, env: Record<string, string>) => [header, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)].join('\n');
  return [
    block('# --- Frontend: Render Static Site ---', config.frontend),
    block('# --- API: Render Web Service ---', config.api),
    block('# --- Migration: operator session only ---', config.migration),
  ].join('\n\n');
}
