/**
 * R1 offline repository checks: the migration chain, Migration 019, the RLS
 * model the migrations define, and the static wiring of the data and identity
 * paths. They read files in this checkout only; nothing is contacted.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { check, type Check } from './checks.js';

export const MIGRATION_019 = '019_revoke_public_function_execute.sql';

/** Statements that make Migration 019 what it is (compared case- and whitespace-insensitively). */
const MIGRATION_019_STATEMENTS = [
  'revoke execute on all functions in schema public from public',
  'alter default privileges revoke execute on functions from public',
];

export type SourceFile = { path: string; content: string };

/** The registered chain must be 001..N in order, every file present, and no numbered file unregistered. */
export function checkMigrationChain(registered: readonly string[], onDisk: readonly string[]): Check {
  const problems: string[] = [];
  const pattern = /^(\d{3})_[a-z0-9_]+\.sql$/;
  registered.forEach((name, index) => {
    const match = pattern.exec(name);
    if (!match) problems.push(`registered name is not NNN_name.sql: ${name}`);
    else if (Number(match[1]) !== index + 1) problems.push(`position ${index + 1} holds ${name} (expected number ${String(index + 1).padStart(3, '0')})`);
  });
  const seen = new Set<string>();
  for (const name of registered) {
    if (seen.has(name)) problems.push(`registered twice: ${name}`);
    seen.add(name);
  }
  const numbered = onDisk.filter((name) => /^\d{3}_.+\.sql$/.test(name));
  for (const name of registered) if (!numbered.includes(name)) problems.push(`registered but missing from database/: ${name}`);
  for (const name of numbered) if (!registered.includes(name)) problems.push(`in database/ but not registered: ${name}`);
  return check(
    'R1-REPO-MIGRATION-CHAIN',
    'Migration chain: registered list is 001..N, in order, matching database/',
    problems.length ? 'FAIL' : 'PASS',
    problems.length ? problems : [`${registered.length} migrations registered, contiguous; first ${registered[0]}, last ${registered.at(-1)}`],
    'repository',
  );
}

export function checkMigration019(registered: readonly string[], onDisk: readonly string[], content: string | null): Check {
  const problems: string[] = [];
  const position = registered.indexOf(MIGRATION_019);
  if (position < 0) problems.push(`${MIGRATION_019} is not registered in the migration chain`);
  if (!onDisk.includes(MIGRATION_019) || content === null) problems.push(`${MIGRATION_019} is missing from database/`);
  if (content !== null) {
    const normalized = content.toLowerCase().replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
    for (const statement of MIGRATION_019_STATEMENTS) {
      if (!normalized.includes(statement)) problems.push(`${MIGRATION_019} no longer contains: ${statement}`);
    }
  }
  return check(
    'R1-REPO-MIGRATION-019',
    'Migration 019 (D-PROD-13 function privilege boundary) is present and registered',
    problems.length ? 'FAIL' : 'PASS',
    problems.length ? problems : [`registered at position ${position + 1} of ${registered.length}; revokes PUBLIC EXECUTE now and by default`],
    'repository',
  );
}

export type RlsModel = { tables: Set<string>; policies: Set<string> };

/** Replays create/drop policy and enable/disable RLS statements in chain order. Keys are table or table.policy. */
export function deriveRlsModel(files: readonly SourceFile[]): RlsModel {
  const tables = new Set<string>();
  const policies = new Set<string>();
  const name = String.raw`"?([a-z_][a-z0-9_]*)"?`;
  const target = String.raw`(?:public\.)?${name}`;
  const statement = new RegExp(
    [
      String.raw`create\s+policy\s+${name}\s+on\s+${target}`,
      String.raw`drop\s+policy\s+(?:if\s+exists\s+)?${name}\s+on\s+${target}`,
      String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${target}\s+(enable|disable)\s+row\s+level\s+security`,
    ].join('|'),
    'gi',
  );
  for (const file of files) {
    const sql = file.content.replace(/--[^\n]*/g, ' ');
    for (const match of sql.matchAll(statement)) {
      const [, createName, createTable, dropName, dropTable, alterTable, mode] = match.map((part) => part?.toLowerCase());
      if (createName) policies.add(`${createTable}.${createName}`);
      else if (dropName) policies.delete(`${dropTable}.${dropName}`);
      else if (mode === 'enable') tables.add(alterTable!);
      else tables.delete(alterTable!);
    }
  }
  return { tables, policies };
}

export function checkRepositoryRls(model: RlsModel): Check {
  const inert = [...model.policies].filter((key) => !model.tables.has(key.split('.')[0]));
  return check(
    'R1-REPO-RLS-MODEL',
    'RLS model defined by the migrations (expected state for the database check)',
    inert.length || !model.tables.size ? 'FAIL' : 'PASS',
    inert.length
      ? inert.map((key) => `policy on a table without RLS enabled: ${key}`)
      : model.tables.size
        ? [`${model.tables.size} tables with RLS enabled, ${model.policies.size} policies`]
        : ['no table enables RLS: the model is empty'],
    'repository',
  );
}

const DATA_API_PATH = /\/(rest|graphql|storage|functions|realtime)\/v1\b/;
const SUPABASE_AUTH_MODULE = 'src/auth/supabaseAuth.ts';

/** Supabase Auth is identity only: the Data API, storage, realtime, and functions are never an application path. */
export function checkDataPath(files: readonly SourceFile[]): Check {
  const problems: string[] = [];
  const importers: string[] = [];
  for (const file of files) {
    if (DATA_API_PATH.test(file.content)) problems.push(`${file.path} references a Supabase Data API, storage, realtime, or functions path`);
    if (/from\s+['"]@supabase\//.test(file.content)) {
      importers.push(file.path);
      if (file.path.startsWith('server/')) problems.push(`${file.path} imports a Supabase client: the API must reach data through PostgreSQL`);
      else if (file.path !== SUPABASE_AUTH_MODULE) problems.push(`${file.path} imports the Supabase client outside ${SUPABASE_AUTH_MODULE}`);
    }
  }
  const authModule = files.find((file) => file.path === SUPABASE_AUTH_MODULE);
  if (authModule && /\.(from|rpc|channel|removeChannel|schema)\s*\(|\.(storage|functions|realtime)\b/.test(authModule.content)) {
    problems.push(`${SUPABASE_AUTH_MODULE} uses a Supabase data, storage, realtime, or functions API`);
  }
  const frontend = files.filter((file) => file.path.startsWith('src/')).length;
  const server = files.filter((file) => file.path.startsWith('server/')).length;
  return check(
    'R1-REPO-DATA-PATH',
    'Static wiring: the browser uses Supabase for sign-in only; data goes through the BizcaiaOS API',
    problems.length ? 'FAIL' : 'PASS',
    problems.length
      ? problems
      : [
          `scanned ${frontend} frontend and ${server} API source files (tests excluded)`,
          `Supabase client imported only by: ${importers.join(', ') || 'none'}; no Data API, storage, realtime, or functions paths`,
          'static evidence only: the hosted Data API setting is checked separately (R1-PROVIDER-DATA-API)',
        ],
    'repository',
  );
}

/** The API verifies tokens itself against the configured issuer, audience, and JWKS; the browser only signs in. */
export function checkAuthWiring(files: readonly SourceFile[]): Check {
  const problems: string[] = [];
  const api = files.find((file) => file.path === 'server/auth.ts')?.content;
  const browser = files.find((file) => file.path === SUPABASE_AUTH_MODULE)?.content;
  if (!api) problems.push('server/auth.ts not found');
  else {
    for (const token of ['createRemoteJWKSet', 'jwtVerify', 'process.env.AUTH_JWKS_URL', 'process.env.AUTH_ISSUER', 'process.env.AUTH_AUDIENCE']) {
      if (!api.includes(token)) problems.push(`server/auth.ts no longer uses ${token}`);
    }
    if (!/jwtVerify\([^)]*\{\s*issuer\s*,\s*audience\s*\}/.test(api)) problems.push('server/auth.ts does not pass issuer and audience to jwtVerify');
  }
  if (!browser) problems.push(`${SUPABASE_AUTH_MODULE} not found`);
  else {
    if (!browser.includes('signInWithPassword')) problems.push(`${SUPABASE_AUTH_MODULE} no longer signs in with email and password`);
    for (const flow of ['signUp', 'signInAnonymously', 'signInWithOAuth', 'signInWithOtp']) {
      if (new RegExp(String.raw`\b${flow}\s*\(`).test(browser)) problems.push(`${SUPABASE_AUTH_MODULE} calls ${flow}`);
    }
  }
  return check(
    'R1-REPO-AUTH-WIRING',
    'Static wiring: Supabase Auth is the identity provider; the API verifies tokens (issuer, audience, JWKS from configuration)',
    problems.length ? 'FAIL' : 'PASS',
    problems.length
      ? problems
      : [
          'API: jose jwtVerify against createRemoteJWKSet(AUTH_JWKS_URL) with AUTH_ISSUER and AUTH_AUDIENCE',
          'browser: email/password sign-in only; no sign-up, anonymous, OAuth, or OTP calls',
          'static evidence only: live sign-in and token rejection are runbook step 19',
        ],
    'repository',
  );
}

/** Application sources the static checks read: src/ and server/, without tests. */
export function collectSourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      const path = relative(root, full).replaceAll('\\', '/');
      if (statSync(full).isDirectory()) {
        if (!['integration', 'test', 'node_modules'].includes(entry)) walk(full);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
        files.push({ path, content: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const directory of ['src', 'server']) {
    if (existsSync(join(root, directory))) walk(join(root, directory));
  }
  return files;
}

export function repositoryChecks(root: string, registered: readonly string[]): { checks: Check[]; rls: RlsModel } {
  const databaseDir = join(root, 'database');
  const onDisk = readdirSync(databaseDir);
  const read = (name: string) => (onDisk.includes(name) ? readFileSync(join(databaseDir, name), 'utf8') : null);
  const migrations = registered.filter((name) => onDisk.includes(name)).map((name) => ({ path: name, content: read(name)! }));
  const rls = deriveRlsModel(migrations);
  const sources = collectSourceFiles(root);
  return {
    rls,
    checks: [
      checkMigrationChain(registered, onDisk),
      checkMigration019(registered, onDisk, read(MIGRATION_019)),
      checkRepositoryRls(rls),
      checkDataPath(sources),
      checkAuthWiring(sources),
    ],
  };
}
