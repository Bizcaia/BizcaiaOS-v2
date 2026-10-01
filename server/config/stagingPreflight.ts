/**
 * Staging provisioning gate: "is this staging configuration ready for the
 * provisioning step?"
 *
 * Reads ONE operator-prepared file laid out like deploy/staging.env.example
 * (Frontend, API, and Migration sections), applies the configuration contract
 * to each section (environmentContract.ts), then checks what only the whole
 * set can show: one Supabase project across frontend, API, database, and
 * migration connections; one staging domain; nothing that belongs to
 * production; and every variable in the section (Render service) that reads
 * it. Passwords are never checked, so the file may hold `PASSWORD` in their
 * place and contain no secret at all.
 *
 * It never contacts Supabase, Render, DNS, or a database, never reads .env,
 * and never prints a value: findings name the section and variable only.
 *
 * Usage: npm run staging:preflight -- --env-file <path> [--production-ref <project-ref>]
 * Exit:  0 ready, 1 configuration findings, 2 usage error.
 */
import { readFileSync } from 'node:fs';
import { validateEnvironment, type Scope } from './environmentContract.js';

export type Section = Scope;
export type PreflightFinding = { level: 'error' | 'warning'; section: Section | 'file'; variable: string; message: string };
type Env = Record<string, string>;

const SECTION_HEADERS: Array<[RegExp, Section]> = [
  [/^#\s*-+\s*frontend\b/i, 'frontend'],
  [/^#\s*-+\s*api\b/i, 'api'],
  [/^#\s*-+\s*migration\b/i, 'migration'],
];

/** Variables each section (Render service or operator session) reads. */
const KNOWN: Record<Section, string[]> = {
  frontend: ['NODE_VERSION', 'VITE_API_BASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_ANALYTICS_ENDPOINT', 'VITE_ANALYTICS_WEBSITE_ID'],
  api: [
    'NODE_ENV', 'NODE_VERSION', 'PORT', 'API_PORT', 'CORS_ORIGIN', 'DATABASE_URL', 'DATABASE_SSL', 'DATABASE_POOL_SIZE',
    'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL', 'POSTGRES_APP_USER', 'DOCUMENT_STORAGE_PROVIDER',
    'DOCUMENT_STORAGE_LOCAL_ROOT', 'DOCUMENT_MAX_SIZE_BYTES', 'DOCUMENT_ACCEPTED_MIME_TYPES',
  ],
  migration: ['DATABASE_MIGRATE_URL', 'POSTGRES_APP_USER'],
};

/** Names the application never reads, with the name it does read. */
const ALIASES: Record<string, string> = {
  VITE_SUPABASE_ANON_KEY: 'VITE_SUPABASE_PUBLISHABLE_KEY',
  SUPABASE_URL: 'VITE_SUPABASE_URL (frontend) and AUTH_ISSUER (API)',
  SUPABASE_ANON_KEY: 'VITE_SUPABASE_PUBLISHABLE_KEY',
  DOCUMENT_ROOT: 'DOCUMENT_STORAGE_LOCAL_ROOT',
  JWKS_URL: 'AUTH_JWKS_URL',
};

/** Must never appear in a staging configuration (local-only or never-needed secrets). */
const FORBIDDEN = ['POSTGRES_APP_PASSWORD', 'POSTGRES_PASSWORD', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_JWT_SECRET'];

/** D-PROD-05: the Render persistent disk mount. */
export const DISK_MOUNT = '/var/data';
/** Render routes to PORT, 10000 unless PORT is set on the service. */
export const RENDER_DEFAULT_PORT = '10000';

export class UsageError extends Error {}

export function parseSectionedEnv(contents: string): { sections: Record<Section, Env>; findings: PreflightFinding[] } {
  const sections: Record<Section, Env> = { frontend: {}, api: {}, migration: {} };
  const findings: PreflightFinding[] = [];
  const seen = new Set<Section>();
  let current: Section | null = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = SECTION_HEADERS.find(([pattern]) => pattern.test(line));
    if (header) {
      current = header[1];
      seen.add(current);
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      findings.push({ level: 'error', section: current ?? 'file', variable: '(line)', message: 'is not NAME=value' });
      continue;
    }
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!current) {
      findings.push({ level: 'error', section: 'file', variable: name, message: 'appears before the Frontend, API, or Migration section header' });
      continue;
    }
    if (name in sections[current]) findings.push({ level: 'error', section: current, variable: name, message: 'is set more than once' });
    sections[current][name] = value;
  }
  for (const [, section] of SECTION_HEADERS) {
    if (!seen.has(section)) {
      findings.push({ level: 'error', section: 'file', variable: section, message: 'section header is missing (keep the headers from deploy/staging.env.example)' });
    }
  }
  return { sections, findings };
}

function parseUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Placeholder left from the template. Database passwords are ignored, so `PASSWORD` may stand in for them. */
function isPlaceholder(value: string) {
  const url = parseUrl(value);
  const checked = url && ['postgres:', 'postgresql:'].includes(url.protocol) ? value.replace(/\/\/([^:@/]*):[^@]*@/, '//$1@') : value;
  return /<[^>]*>|YOUR_|replace-with/i.test(checked);
}

/** Supabase project reference of a database URL: pooler user "<role>.<ref>" or direct host "db.<ref>.supabase.co". */
export function databaseProjectRef(url: URL): string | null {
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname);
  if (direct) return direct[1];
  if (url.hostname.endsWith('.pooler.supabase.com')) {
    const [, ref] = decodeURIComponent(url.username).split('.');
    return ref || null;
  }
  return null;
}

export function stagingPreflight(sections: Record<Section, Env>, options: { productionRef?: string } = {}): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const error = (section: Section, variable: string, message: string) => findings.push({ level: 'error', section, variable, message });
  const warning = (section: Section, variable: string, message: string) => findings.push({ level: 'warning', section, variable, message });
  const { frontend, api, migration } = sections;

  // 1. The configuration contract, per section, exactly as config:check applies it.
  for (const section of ['frontend', 'api', 'migration'] as const) {
    for (const finding of validateEnvironment(sections[section], { target: 'staging', scopes: [section] })) {
      findings.push({ ...finding, section });
    }
  }

  // 2. Every variable is filled in, known, and in the section that reads it.
  for (const section of ['frontend', 'api', 'migration'] as const) {
    for (const [name, value] of Object.entries(sections[section])) {
      if (FORBIDDEN.includes(name)) {
        error(section, name, 'must not be part of a staging configuration (local-only or never needed by BizcaiaOS)');
      } else if (ALIASES[name]) {
        error(section, name, `is not read by BizcaiaOS; use ${ALIASES[name]}`);
      } else if (!KNOWN[section].includes(name)) {
        const owner = (['frontend', 'api', 'migration'] as const).find((other) => KNOWN[other].includes(name));
        if (owner) error(section, name, `belongs in the ${owner} section, not ${section}`);
        else warning(section, name, `is not part of the ${section} configuration contract`);
      }
      if (value && isPlaceholder(value)) error(section, name, 'is still a template placeholder');
    }
  }
  for (const section of ['frontend', 'api'] as const) {
    if (!sections[section].NODE_VERSION?.trim()) error(section, 'NODE_VERSION', 'is required (24) so Render builds with the tested Node.js version');
  }
  if (frontend.NODE_VERSION && api.NODE_VERSION && frontend.NODE_VERSION !== api.NODE_VERSION) {
    error('api', 'NODE_VERSION', 'must equal the frontend NODE_VERSION');
  }

  // 3. One staging domain (D-PROD-06): staging.<domain> and api-staging.<domain>.
  const frontendHost = parseUrl(api.CORS_ORIGIN)?.hostname;
  const apiHost = parseUrl(frontend.VITE_API_BASE_URL)?.hostname;
  const domainFromFrontend = frontendHost?.startsWith('staging.') ? frontendHost.slice('staging.'.length) : undefined;
  const domainFromApi = apiHost?.startsWith('api-staging.') ? apiHost.slice('api-staging.'.length) : undefined;
  for (const [section, name, domain] of [['api', 'CORS_ORIGIN', domainFromFrontend], ['frontend', 'VITE_API_BASE_URL', domainFromApi]] as const) {
    if (domain !== undefined && (!domain.includes('.') || /^[\d.]+$/.test(domain))) error(section, name, 'has no real staging domain after the staging prefix');
  }
  if (domainFromFrontend && domainFromApi && domainFromFrontend !== domainFromApi) {
    error('frontend', 'VITE_API_BASE_URL', 'and CORS_ORIGIN must use the same <domain> (staging.<domain> / api-staging.<domain>)');
  }
  for (const section of ['frontend', 'api'] as const) {
    for (const [name, value] of Object.entries(sections[section])) {
      const host = parseUrl(value)?.hostname;
      if (host && /^(app|api)\./.test(host)) error(section, name, 'points at a production host (app.<domain> or api.<domain>)');
    }
  }

  // 4. One Supabase project for sign-in, token checks, the database, and migrations.
  const refs: Array<[Section, string, string]> = [];
  const supabaseUrl = parseUrl(frontend.VITE_SUPABASE_URL);
  if (supabaseUrl) {
    const match = /^([a-z0-9]+)\.supabase\.co$/.exec(supabaseUrl.hostname);
    if (match) refs.push(['frontend', 'VITE_SUPABASE_URL', match[1]]);
    else error('frontend', 'VITE_SUPABASE_URL', 'must be https://<project-ref>.supabase.co (D-PROD-02: Supabase staging project)');
  }
  if (api.AUTH_ISSUER) {
    const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\/auth\/v1$/.exec(api.AUTH_ISSUER.trim());
    if (match) refs.push(['api', 'AUTH_ISSUER', match[1]]);
    else error('api', 'AUTH_ISSUER', 'must be exactly https://<project-ref>.supabase.co/auth/v1');
  }
  for (const [section, name] of [['api', 'DATABASE_URL'], ['migration', 'DATABASE_MIGRATE_URL']] as const) {
    const url = parseUrl(sections[section][name]);
    if (!url || !['postgres:', 'postgresql:'].includes(url.protocol)) continue;
    const ref = databaseProjectRef(url);
    if (ref) refs.push([section, name, ref]);
    else error(section, name, 'must use the Supabase staging database (db.<ref>.supabase.co, or the pooler with user <role>.<ref>)');
  }
  const distinct = new Set(refs.map(([, , ref]) => ref));
  if (distinct.size > 1) {
    for (const [section, name] of refs) error(section, name, 'uses a different Supabase project reference than the rest of the staging configuration');
  }
  for (const [section, name, ref] of refs) {
    if (!/^[a-z0-9]{20}$/.test(ref)) warning(section, name, 'project reference is not the usual 20 lowercase characters; check for a typo');
    if (options.productionRef && ref === options.productionRef) error(section, name, 'points at the PRODUCTION Supabase project');
  }

  // 5. TLS on the API connection: sslmode in DATABASE_URL overrides DATABASE_SSL.
  const sslmode = parseUrl(api.DATABASE_URL)?.searchParams.get('sslmode');
  if (sslmode && !['require', 'verify-ca', 'verify-full'].includes(sslmode)) {
    error('api', 'DATABASE_URL', 'sslmode in the URL disables certificate verification; remove it or use verify-full');
  }

  // 6. Render: port and persistent disk.
  if (!api.PORT && api.API_PORT && api.API_PORT !== RENDER_DEFAULT_PORT) {
    error('api', 'API_PORT', `must be ${RENDER_DEFAULT_PORT} (Render's default PORT) unless PORT is set to the same value`);
  }
  const documentRoot = api.DOCUMENT_STORAGE_LOCAL_ROOT?.trim();
  if (documentRoot?.startsWith('/') && !documentRoot.startsWith(`${DISK_MOUNT}/`)) {
    error('api', 'DOCUMENT_STORAGE_LOCAL_ROOT', `must be inside the persistent disk mount ${DISK_MOUNT} (D-PROD-05), or documents are lost on redeploy`);
  }

  return findings;
}

function parseArguments(argv: string[]) {
  const options: { envFile?: string; productionRef?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if ((flag === '--env-file' || flag === '--production-ref') && next && !next.startsWith('--')) {
      if (flag === '--env-file') options.envFile = next;
      else options.productionRef = next;
      index += 1;
    } else {
      throw new UsageError(`Unknown or incomplete argument: ${flag}`);
    }
  }
  if (!options.envFile) throw new UsageError('--env-file is required');
  return options as { envFile: string; productionRef?: string };
}

const USAGE = 'Usage: npm run staging:preflight -- --env-file <path> [--production-ref <project-ref>]';

/** CLI body, injectable for tests. Returns the exit code. */
export function runPreflight(argv: string[], readFile: (path: string) => string, log: (line: string) => void): number {
  let options: { envFile: string; productionRef?: string };
  let contents: string;
  try {
    options = parseArguments(argv);
    try {
      contents = readFile(options.envFile);
    } catch {
      throw new UsageError('cannot read the --env-file');
    }
  } catch (failure) {
    log(`${failure instanceof Error ? failure.message : String(failure)}\n${USAGE}`);
    return 2;
  }
  const parsed = parseSectionedEnv(contents);
  const findings = [...parsed.findings, ...stagingPreflight(parsed.sections, options)];
  for (const finding of findings) log(`${finding.level.toUpperCase()} [${finding.section}] ${finding.variable}: ${finding.message}`);
  const errors = findings.filter((finding) => finding.level === 'error').length;
  log(errors
    ? `staging preflight: NOT READY, ${errors} error(s), ${findings.length - errors} warning(s)`
    : `staging preflight: READY, 0 error(s), ${findings.length} warning(s). Nothing was contacted or provisioned.`);
  return errors ? 1 : 0;
}

const invokedDirectly = process.argv[1]?.replaceAll('\\', '/').endsWith('/stagingPreflight.ts');
if (invokedDirectly) {
  process.exit(runPreflight(process.argv.slice(2), (path) => readFileSync(path, 'utf8'), (line) => console.log(line)));
}
