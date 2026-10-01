/**
 * R1 offline configuration checks over one sectioned environment file laid
 * out like deploy/staging.env.example (Frontend, API, Migration). The
 * contract itself is applied by config:check / staging:preflight and reused
 * here as R1-CFG-CONTRACT; the other checks state each boundary relationship
 * on its own so a review sees which one broke. Findings name variables only,
 * never values. Nothing is contacted.
 */
import { validateEnvironment, type Finding } from '../config/environmentContract.js';
import { databaseProjectRef, parseSectionedEnv, stagingPreflight, type Section } from '../config/stagingPreflight.js';
import { check, NOT_VERIFIED_CONFIGURATION, type Check } from './checks.js';

export type DeployTarget = 'staging' | 'production';
type Sections = Record<Section, Record<string, string>>;

export const DEFAULT_APP_ROLE = 'bizcaiaos_app';
export const MIGRATOR_ROLE = 'bizcaiaos_migrator';

const SECTIONS: Section[] = ['frontend', 'api', 'migration'];
const DATA_API_PATH = /\/(rest|graphql|storage|functions|realtime)\/v1\b/;
const HOSTS: Record<DeployTarget, { frontend: string; api: string }> = {
  staging: { frontend: 'staging.', api: 'api-staging.' },
  production: { frontend: 'app.', api: 'api.' },
};

const CHECK_TITLES = {
  'R1-CFG-CONTRACT': 'Configuration contract (config:check rules per section; staging:preflight for staging)',
  'R1-CFG-PROJECT': 'One Supabase project: frontend URL, Auth issuer, JWKS, API database, migration database',
  'R1-CFG-ENVIRONMENT': 'Hosts and project belong to the target environment (no staging/production leakage)',
  'R1-CFG-PUBLIC-SECRETS': 'Public frontend (Static Site) variables hold no secret credentials',
  'R1-CFG-APP-ROLE': 'API database connection uses the application role',
  'R1-CFG-MIGRATION-SEPARATION': 'Migration credentials stay out of the runtime API; migrations use the migration role',
  'R1-CFG-DATA-API': 'No configured URL makes the Supabase Data API an application data path',
} as const;

function parseUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function databaseRole(raw: string | undefined): string | null {
  const url = parseUrl(raw);
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol)) return null;
  return decodeURIComponent(url.username).split('.')[0] || null;
}

/** Supabase project reference of a configured value, null when it is not a Supabase URL. */
function projectRef(name: string, raw: string): string | null {
  const url = parseUrl(raw);
  if (!url) return null;
  if (name === 'DATABASE_URL' || name === 'DATABASE_MIGRATE_URL') return databaseProjectRef(url);
  return /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1] ?? null;
}

function decodeJwtRole(token: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { role?: unknown }).role;
  } catch {
    return undefined;
  }
}

function contractFindings(sections: Sections, target: DeployTarget, otherRef: string | undefined) {
  if (target === 'staging') return stagingPreflight(sections, { productionRef: otherRef });
  const findings: Array<Finding & { section: string }> = [];
  for (const section of SECTIONS) {
    for (const finding of validateEnvironment(sections[section], { target, scopes: [section] })) findings.push({ ...finding, section });
  }
  // The frontend/API identity rule needs both sections at once.
  for (const finding of validateEnvironment({ ...sections.frontend, ...sections.api }, { target, scopes: ['frontend', 'api'] })) {
    if (finding.variable === 'AUTH_ISSUER' && finding.message.includes('different Supabase projects')) findings.push({ ...finding, section: 'api' });
  }
  return findings;
}

export function configurationChecks(contents: string, options: { target: DeployTarget; otherRef?: string }): Check[] {
  const parsed = parseSectionedEnv(contents);
  const sections = parsed.sections;
  const { frontend, api, migration } = sections;
  const checks: Check[] = [];

  // R1-CFG-CONTRACT
  const findings = [...parsed.findings, ...contractFindings(sections, options.target, options.otherRef)];
  const lines = [...new Set(findings.map((finding) => `${finding.level === 'error' ? '' : 'warning: '}[${finding.section}] ${finding.variable}: ${finding.message}`))];
  const errors = findings.filter((finding) => finding.level === 'error').length;
  checks.push(check('R1-CFG-CONTRACT', CHECK_TITLES['R1-CFG-CONTRACT'], errors ? 'FAIL' : 'PASS',
    lines.length ? lines : [`${options.target} contract: 0 errors, 0 warnings`], 'configuration'));

  // R1-CFG-PROJECT
  const located: Array<[string, string | null]> = [];
  for (const [section, name] of [['frontend', 'VITE_SUPABASE_URL'], ['api', 'AUTH_ISSUER'], ['api', 'AUTH_JWKS_URL'], ['api', 'DATABASE_URL'], ['migration', 'DATABASE_MIGRATE_URL']] as const) {
    const raw = sections[section][name];
    if (raw) located.push([name, projectRef(name, raw)]);
  }
  const refs = [...new Set(located.map(([, ref]) => ref).filter((ref): ref is string => Boolean(ref)))];
  const unidentified = located.filter(([, ref]) => !ref).map(([name]) => name);
  const missing = ['VITE_SUPABASE_URL', 'AUTH_ISSUER', 'AUTH_JWKS_URL', 'DATABASE_URL', 'DATABASE_MIGRATE_URL'].filter((name) => !located.some(([found]) => found === name));
  const projectEvidence = refs.map((ref, index) => `project #${index + 1}: ${located.filter(([, found]) => found === ref).map(([name]) => name).join(', ')}`);
  if (unidentified.length) projectEvidence.push(`not a Supabase project URL: ${unidentified.join(', ')}`);
  if (missing.length) projectEvidence.push(`not set: ${missing.join(', ')}`);
  checks.push(check('R1-CFG-PROJECT', CHECK_TITLES['R1-CFG-PROJECT'],
    refs.length > 1 || unidentified.length || !refs.length ? 'FAIL' : missing.length ? 'NOT_VERIFIED' : 'PASS',
    refs.length > 1 ? ['values point at more than one Supabase project', ...projectEvidence] : projectEvidence, 'configuration'));

  // R1-CFG-ENVIRONMENT
  const leaks: string[] = [];
  const prefixes = HOSTS[options.target];
  const frontendHost = parseUrl(api.CORS_ORIGIN)?.hostname;
  const apiHost = parseUrl(frontend.VITE_API_BASE_URL)?.hostname;
  if (!frontendHost || !apiHost) leaks.push(`not set or not a URL: ${[!apiHost && 'VITE_API_BASE_URL', !frontendHost && 'CORS_ORIGIN'].filter(Boolean).join(', ')}`);
  if (apiHost && !apiHost.startsWith(prefixes.api)) leaks.push(`VITE_API_BASE_URL host is not ${prefixes.api}<domain> (${options.target})`);
  if (frontendHost && !frontendHost.startsWith(prefixes.frontend)) leaks.push(`CORS_ORIGIN host is not ${prefixes.frontend}<domain> (${options.target})`);
  if (frontendHost?.startsWith(prefixes.frontend) && apiHost?.startsWith(prefixes.api)
    && frontendHost.slice(prefixes.frontend.length) !== apiHost.slice(prefixes.api.length)) {
    leaks.push('VITE_API_BASE_URL and CORS_ORIGIN use different <domain> values');
  }
  for (const section of SECTIONS) {
    for (const [name, raw] of Object.entries(sections[section])) {
      const host = parseUrl(raw)?.hostname;
      if (!host) continue;
      if (options.target === 'staging' && /^(app|api)\./.test(host)) leaks.push(`[${section}] ${name} points at a production host`);
      if (options.target === 'production' && host.includes('staging')) leaks.push(`[${section}] ${name} points at a staging host`);
    }
  }
  if (options.otherRef) {
    for (const [name, ref] of located) {
      if (ref === options.otherRef) leaks.push(`${name} points at the other environment's Supabase project (--other-ref)`);
    }
  }
  checks.push(check('R1-CFG-ENVIRONMENT', CHECK_TITLES['R1-CFG-ENVIRONMENT'], leaks.length ? 'FAIL' : 'PASS',
    leaks.length ? leaks : [
      `frontend ${prefixes.frontend}<domain> and API ${prefixes.api}<domain> share one domain`,
      options.otherRef ? 'no value points at the other environment\'s Supabase project' : 'no --other-ref supplied: cross-project leakage checked by host names only',
    ], 'configuration'));

  // R1-CFG-PUBLIC-SECRETS
  const exposed: string[] = [];
  for (const [name, raw] of Object.entries(frontend)) {
    if (/SECRET|SERVICE_ROLE|PASSWORD|PRIVATE|DATABASE/i.test(name)) exposed.push(`${name} is a secret-looking name on the public Static Site`);
    else if (/postgres(ql)?:\/\//i.test(raw)) exposed.push(`${name} holds a database connection string`);
    else if (raw.startsWith('sb_secret_')) exposed.push(`${name} holds a Supabase secret key`);
    else if (decodeJwtRole(raw) === 'service_role') exposed.push(`${name} holds a service_role key`);
  }
  checks.push(check('R1-CFG-PUBLIC-SECRETS', CHECK_TITLES['R1-CFG-PUBLIC-SECRETS'], exposed.length ? 'FAIL' : 'PASS',
    exposed.length ? exposed : [`${Object.keys(frontend).length} frontend variables: no secret names, connection strings, secret or service_role keys`], 'configuration'));

  // R1-CFG-APP-ROLE
  const appRole = api.POSTGRES_APP_USER || migration.POSTGRES_APP_USER || DEFAULT_APP_ROLE;
  const apiRole = databaseRole(api.DATABASE_URL);
  checks.push(check('R1-CFG-APP-ROLE', CHECK_TITLES['R1-CFG-APP-ROLE'],
    apiRole === appRole ? 'PASS' : 'FAIL',
    !api.DATABASE_URL ? ['[api] DATABASE_URL is not set']
      : !apiRole ? ['[api] DATABASE_URL is not a postgres:// connection string']
        : apiRole === appRole ? [`[api] DATABASE_URL connects as ${appRole}`]
          : [apiRole === MIGRATOR_ROLE ? `[api] DATABASE_URL connects as the migration role ${MIGRATOR_ROLE}` : `[api] DATABASE_URL connects as ${apiRole}, not ${appRole}`],
    'configuration'));

  // R1-CFG-MIGRATION-SEPARATION
  const separation: string[] = [];
  for (const section of ['frontend', 'api'] as const) {
    for (const name of ['DATABASE_MIGRATE_URL', 'POSTGRES_APP_PASSWORD', 'POSTGRES_PASSWORD']) {
      if (sections[section][name]) separation.push(`[${section}] ${name} is migration/operator-only and must not be on a Render service`);
    }
  }
  const migrationRole = databaseRole(migration.DATABASE_MIGRATE_URL);
  if (migration.DATABASE_MIGRATE_URL) {
    if (migrationRole !== MIGRATOR_ROLE) separation.push(`[migration] DATABASE_MIGRATE_URL does not connect as ${MIGRATOR_ROLE}`);
    if (parseUrl(migration.DATABASE_MIGRATE_URL)?.port === '6543') separation.push('[migration] DATABASE_MIGRATE_URL uses the transaction pooler (6543)');
    if (apiRole && migrationRole && apiRole === migrationRole) separation.push('DATABASE_URL and DATABASE_MIGRATE_URL use the same role');
  }
  checks.push(check('R1-CFG-MIGRATION-SEPARATION', CHECK_TITLES['R1-CFG-MIGRATION-SEPARATION'],
    separation.length ? 'FAIL' : migration.DATABASE_MIGRATE_URL ? 'PASS' : 'NOT_VERIFIED',
    separation.length ? separation : migration.DATABASE_MIGRATE_URL
      ? [`no migration credentials in the frontend or API sections; [migration] DATABASE_MIGRATE_URL connects as ${MIGRATOR_ROLE} on a session port`]
      : ['no migration credentials in the frontend or API sections', '[migration] DATABASE_MIGRATE_URL not set: the migration role is not checked'],
    'configuration'));

  // R1-CFG-DATA-API
  const dataPaths: string[] = [];
  for (const section of SECTIONS) {
    for (const [name, raw] of Object.entries(sections[section])) {
      if (parseUrl(raw) && DATA_API_PATH.test(raw)) dataPaths.push(`[${section}] ${name} targets a Supabase Data API, storage, realtime, or functions path`);
    }
  }
  if (apiHost && /\.supabase\.(co|in)$/.test(apiHost)) dataPaths.push('[frontend] VITE_API_BASE_URL is a Supabase endpoint, not the BizcaiaOS API');
  checks.push(check('R1-CFG-DATA-API', CHECK_TITLES['R1-CFG-DATA-API'], dataPaths.length ? 'FAIL' : 'PASS',
    dataPaths.length ? dataPaths : ['VITE_API_BASE_URL is the BizcaiaOS API; no configured URL targets /rest, /graphql, /storage, /realtime, or /functions'],
    'configuration'));

  return checks;
}

export function configurationNotSupplied(): Check[] {
  return Object.entries(CHECK_TITLES).map(([id, title]) =>
    check(id, title, 'NOT_VERIFIED', [`${NOT_VERIFIED_CONFIGURATION} (pass --env-file with --target staging|production)`], 'configuration'));
}

/** Values in the file that must never be printed: database URLs, their passwords, and keys. */
export function configurationSecrets(contents: string): string[] {
  const { sections } = parseSectionedEnv(contents);
  const secrets: string[] = [];
  for (const section of SECTIONS) {
    for (const [name, raw] of Object.entries(sections[section])) {
      if (!raw) continue;
      if (/URL|KEY|PASSWORD|SECRET|TOKEN/i.test(name) && !/^https?:\/\//.test(raw)) secrets.push(raw);
      const url = parseUrl(raw);
      if (url?.password) secrets.push(raw, decodeURIComponent(url.password), url.password);
    }
  }
  // `PASSWORD` is the documented stand-in for a password, not a secret.
  return [...new Set(secrets.filter((value) => value.length >= 4 && value !== 'PASSWORD'))];
}
