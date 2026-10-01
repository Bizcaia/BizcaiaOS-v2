/**
 * Deployment configuration contract (local, staging, production).
 *
 * Checks a set of environment variables against the BizcaiaOS contract before
 * a deploy: required values, URL shapes, the D-PROD-06 domain layout, the
 * D-PROD-13 boundary (Supabase Auth only; no secrets in public VITE_ values),
 * and the C-02 migration-connection rules. It never contacts Supabase, Render,
 * or a database, never reads .env, and never prints a value: findings name
 * the variable only.
 *
 * Usage: npm run config:check -- --target staging --scope frontend,api
 */

export type Target = 'local' | 'staging' | 'production';
export type Scope = 'frontend' | 'api' | 'migration';
export type Finding = { level: 'error' | 'warning'; variable: string; message: string };
type Env = Record<string, string | undefined>;

export const TARGETS: Target[] = ['local', 'staging', 'production'];
export const SCOPES: Scope[] = ['frontend', 'api', 'migration'];

/** D-PROD-06 host prefixes: staging.<domain> / api-staging.<domain>, app.<domain> / api.<domain>. */
const HOST_PREFIX: Record<'staging' | 'production', { frontend: string; api: string }> = {
  staging: { frontend: 'staging.', api: 'api-staging.' },
  production: { frontend: 'app.', api: 'api.' },
};

const SUPABASE_AUDIENCE = 'authenticated';
const MIGRATION_OWNER = 'bizcaiaos_migrator';

function value(env: Env, name: string) {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Database user name; Supabase pooler user names are "<role>.<project-ref>". */
function databaseRole(url: URL) {
  return decodeURIComponent(url.username).split('.')[0];
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function validateEnvironment(env: Env, options: { target: Target; scopes: Scope[] }): Finding[] {
  const findings: Finding[] = [];
  const deployed = options.target !== 'local';
  const error = (variable: string, message: string) => findings.push({ level: 'error', variable, message });
  const warning = (variable: string, message: string) => findings.push({ level: 'warning', variable, message });

  /** Validates an https (or, locally, http) URL and the D-PROD-06 host prefix. */
  const checkUrl = (name: string, raw: string, role?: 'frontend' | 'api'): URL | null => {
    const url = parseUrl(raw);
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      error(name, 'must be an absolute http(s) URL');
      return null;
    }
    if (deployed && url.protocol !== 'https:') error(name, `must use https for ${options.target}`);
    if (role && options.target !== 'local') {
      const prefix = HOST_PREFIX[options.target][role];
      if (!url.hostname.startsWith(prefix)) error(name, `host must be ${prefix}<domain> for ${options.target} (D-PROD-06)`);
    }
    if (options.target === 'production' && url.hostname.includes('staging')) {
      error(name, 'production must not point at a staging host');
    }
    if (deployed && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
      error(name, `must not point at localhost for ${options.target}`);
    }
    return url;
  };

  if (options.scopes.includes('frontend')) {
    // Public, build-time values: anything VITE_* is embedded in the browser bundle.
    for (const [name, raw] of Object.entries(env)) {
      if (!name.startsWith('VITE_')) continue;
      if (/SECRET|SERVICE_ROLE|PASSWORD|PRIVATE|DATABASE/i.test(name)) {
        error(name, 'VITE_ values are public; a secret must never use a VITE_ name');
      } else if (raw && /postgres(ql)?:\/\//i.test(raw)) {
        error(name, 'contains a database connection string; VITE_ values are public');
      }
    }

    const apiBase = value(env, 'VITE_API_BASE_URL');
    if (!apiBase) {
      if (deployed) error('VITE_API_BASE_URL', `is required for ${options.target} (empty builds demo mode)`);
    } else {
      const url = checkUrl('VITE_API_BASE_URL', apiBase, 'api');
      if (url && url.pathname.replace(/\/$/, '') !== '/api/v1') error('VITE_API_BASE_URL', 'must end with /api/v1');
    }

    const supabaseUrl = value(env, 'VITE_SUPABASE_URL');
    const publishableKey = value(env, 'VITE_SUPABASE_PUBLISHABLE_KEY');
    if (!supabaseUrl || !publishableKey) {
      if (deployed) {
        if (!supabaseUrl) error('VITE_SUPABASE_URL', `is required for ${options.target} (sign-in is off without it)`);
        if (!publishableKey) error('VITE_SUPABASE_PUBLISHABLE_KEY', `is required for ${options.target}`);
      } else if (supabaseUrl || publishableKey) {
        warning(supabaseUrl ? 'VITE_SUPABASE_PUBLISHABLE_KEY' : 'VITE_SUPABASE_URL', 'set both Supabase values, or neither');
      } else if (apiBase) {
        warning('VITE_SUPABASE_URL', 'live mode without Supabase Auth: API calls fail with "Authentication provider is not connected"');
      }
    }
    if (supabaseUrl) {
      const url = checkUrl('VITE_SUPABASE_URL', supabaseUrl);
      if (url && url.pathname !== '/') error('VITE_SUPABASE_URL', 'must be the project URL only, without a path');
    }
    if (publishableKey) {
      if (publishableKey.startsWith('sb_secret_')) {
        error('VITE_SUPABASE_PUBLISHABLE_KEY', 'is a Supabase secret key; only the publishable (anon) key may reach the browser');
      } else if (decodeJwtPayload(publishableKey)?.role === 'service_role') {
        error('VITE_SUPABASE_PUBLISHABLE_KEY', 'is a service_role key; only the publishable (anon) key may reach the browser');
      }
    }
  }

  if (options.scopes.includes('api')) {
    const nodeEnv = value(env, 'NODE_ENV');
    if (nodeEnv === 'test') error('NODE_ENV', 'must not be "test": the API does not listen in test mode');
    if (deployed && nodeEnv !== 'production') error('NODE_ENV', `must be "production" for ${options.target}`);

    const apiPort = value(env, 'API_PORT');
    const port = value(env, 'PORT');
    if (apiPort && !/^\d+$/.test(apiPort)) error('API_PORT', 'must be a port number');
    if (deployed && !apiPort) error('API_PORT', `is required for ${options.target}; the API listens on API_PORT (default 8787), not PORT`);
    if (apiPort && port && apiPort !== port) error('API_PORT', 'must equal PORT, the port the host routes traffic to');

    const corsOrigin = value(env, 'CORS_ORIGIN');
    if (!corsOrigin) {
      if (deployed) error('CORS_ORIGIN', `is required for ${options.target} (the default is http://localhost:5173)`);
    } else if (corsOrigin === '*' || corsOrigin.includes(',')) {
      error('CORS_ORIGIN', 'must be exactly one origin');
    } else {
      const url = checkUrl('CORS_ORIGIN', corsOrigin, 'frontend');
      if (url && (url.pathname !== '/' || corsOrigin.endsWith('/') || url.search || url.hash)) {
        error('CORS_ORIGIN', 'must be an origin only (scheme, host, optional port) with no path or trailing slash');
      }
    }

    const issuer = value(env, 'AUTH_ISSUER');
    const audience = value(env, 'AUTH_AUDIENCE');
    const jwksUrl = value(env, 'AUTH_JWKS_URL');
    if (!issuer || !audience || !jwksUrl) {
      for (const [name, present] of [['AUTH_ISSUER', issuer], ['AUTH_AUDIENCE', audience], ['AUTH_JWKS_URL', jwksUrl]] as const) {
        if (present) continue;
        if (deployed) error(name, `is required for ${options.target}`);
        else warning(name, 'is not set: every authenticated API request returns 503');
      }
    }
    if (issuer) {
      const url = checkUrl('AUTH_ISSUER', issuer);
      if (url && !url.pathname.replace(/\/$/, '').endsWith('/auth/v1')) {
        warning('AUTH_ISSUER', 'is not a Supabase Auth issuer (https://<project-ref>.supabase.co/auth/v1)');
      }
      if (jwksUrl && jwksUrl !== `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`) {
        error('AUTH_JWKS_URL', 'must be AUTH_ISSUER + /.well-known/jwks.json');
      }
    }
    if (audience && audience !== SUPABASE_AUDIENCE) {
      (deployed ? error : warning)('AUTH_AUDIENCE', `must be "${SUPABASE_AUDIENCE}" for Supabase Auth access tokens`);
    }

    const databaseUrl = value(env, 'DATABASE_URL');
    const appRole = value(env, 'POSTGRES_APP_USER') ?? 'bizcaiaos_app';
    if (!databaseUrl) {
      (deployed ? error : warning)('DATABASE_URL', 'is required: the API connects as the application role');
    } else {
      const url = parseUrl(databaseUrl);
      if (!url || !['postgres:', 'postgresql:'].includes(url.protocol)) {
        error('DATABASE_URL', 'must be a postgres:// connection string');
      } else if (deployed) {
        const role = databaseRole(url);
        if (role !== appRole) error('DATABASE_URL', `must connect as the application role (${appRole}), never as postgres or the migration owner`);
        if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) error('DATABASE_URL', `must not point at localhost for ${options.target}`);
      }
    }
    if (deployed && value(env, 'DATABASE_SSL') !== 'require') error('DATABASE_SSL', `must be "require" for ${options.target}`);
    const poolSize = value(env, 'DATABASE_POOL_SIZE');
    if (poolSize && !/^[1-9]\d*$/.test(poolSize)) error('DATABASE_POOL_SIZE', 'must be a positive integer');

    // Migration credentials belong to the operator's migration session only.
    if (deployed) {
      for (const name of ['DATABASE_MIGRATE_URL', 'POSTGRES_APP_PASSWORD']) {
        if (value(env, name)) error(name, 'is operator-only migration configuration; never set it on the API service');
      }
    }

    const provider = value(env, 'DOCUMENT_STORAGE_PROVIDER');
    if (provider && provider !== 'local') error('DOCUMENT_STORAGE_PROVIDER', 'only "local" is implemented (C-03 is not authorized)');
    const documentRoot = value(env, 'DOCUMENT_STORAGE_LOCAL_ROOT');
    if (deployed && (!documentRoot || !documentRoot.startsWith('/'))) {
      error('DOCUMENT_STORAGE_LOCAL_ROOT', `must be an absolute path inside the persistent disk mount for ${options.target}`);
    }
  }

  // Frontend and API must use the same Supabase project, or every token is rejected.
  if (options.scopes.includes('frontend') && options.scopes.includes('api')) {
    const supabaseUrl = value(env, 'VITE_SUPABASE_URL');
    const issuer = value(env, 'AUTH_ISSUER');
    if (supabaseUrl && issuer && issuer.replace(/\/$/, '') !== `${supabaseUrl.replace(/\/$/, '')}/auth/v1`) {
      error('AUTH_ISSUER', 'must be VITE_SUPABASE_URL + /auth/v1: the frontend and API point at different Supabase projects');
    }
  }

  if (options.scopes.includes('migration')) {
    const migrateUrl = value(env, 'DATABASE_MIGRATE_URL');
    if (!migrateUrl) {
      error('DATABASE_MIGRATE_URL', 'is required to run migrations');
    } else {
      const url = parseUrl(migrateUrl);
      if (!url || !['postgres:', 'postgresql:'].includes(url.protocol)) {
        error('DATABASE_MIGRATE_URL', 'must be a postgres:// connection string');
      } else {
        if (url.port === '6543') {
          error('DATABASE_MIGRATE_URL', 'uses the transaction pooler (6543); migrations need a direct or session connection (advisory lock)');
        }
        if (deployed) {
          if (url.searchParams.get('sslmode') !== 'require' && url.searchParams.get('sslmode') !== 'verify-full') {
            error('DATABASE_MIGRATE_URL', 'must set sslmode=require (the migration runner ignores DATABASE_SSL)');
          }
          const role = databaseRole(url);
          if (role !== MIGRATION_OWNER) {
            error('DATABASE_MIGRATE_URL', `must connect as the dedicated migration owner (${MIGRATION_OWNER}), not postgres or the application role`);
          }
        }
      }
    }
    const appRole = value(env, 'POSTGRES_APP_USER');
    if (appRole && !/^[a-z_][a-z0-9_]*$/.test(appRole)) error('POSTGRES_APP_USER', 'must be a plain lowercase role name');
  }

  return findings;
}

function parseArguments(argv: string[]) {
  const read = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const target = read('--target') as Target | undefined;
  const scopes = (read('--scope') ?? '').split(',').filter(Boolean) as Scope[];
  if (!target || !TARGETS.includes(target) || !scopes.length || scopes.some((scope) => !SCOPES.includes(scope))) {
    throw new Error(`Usage: config:check -- --target ${TARGETS.join('|')} --scope ${SCOPES.join(',')}`);
  }
  return { target, scopes };
}

const invokedDirectly = process.argv[1]?.replaceAll('\\', '/').endsWith('/environmentContract.ts');
if (invokedDirectly) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const findings = validateEnvironment(process.env, options);
    for (const finding of findings) console.log(`${finding.level.toUpperCase()} ${finding.variable}: ${finding.message}`);
    const errors = findings.filter((finding) => finding.level === 'error').length;
    console.log(`${options.target} [${options.scopes.join(',')}]: ${errors} error(s), ${findings.length - errors} warning(s)`);
    process.exit(errors ? 1 : 0);
  } catch (failure) {
    console.error(failure instanceof Error ? failure.message : failure);
    process.exit(2);
  }
}
