/**
 * R1: read-only boundary verifier.
 *
 * Collects evidence that an environment follows the accepted architecture
 * (docs/deployment/production-readiness.md): the browser signs in with
 * Supabase Auth and reaches data only through the BizcaiaOS API, the API
 * connects as bizcaiaos_app, migrations stay with bizcaiaos_migrator, the
 * Supabase Data API is not a data path, and Migration 019 and RLS hold.
 *
 * R1 = READ-ONLY VERIFICATION. It does not provision, migrate, deploy, or
 * modify database state, and it never prints a secret value.
 *
 *   repository checks      always (offline; this checkout's files)
 *   configuration checks   --env-file <file> with --target staging|production (offline)
 *   database checks        --database: one read-only catalog snapshot over the connection
 *                          in DATABASE_MIGRATE_URL (or --database-url-env NAME)
 *
 * Usage: npm run db:verify-boundary -- [--target local|staging|production] [--env-file <file>]
 *          [--other-ref <project-ref>] [--database] [--database-url-env NAME] [--strict] [--json]
 * Exit:  0 no FAIL (and, with --strict, no required check NOT_VERIFIED); 1 otherwise; 2 usage or
 *        configuration error (bad arguments, unreadable file, missing or failed database connection).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, type Check, type Status } from './boundary/checks.js';
import { configurationChecks, configurationNotSupplied, configurationSecrets, DEFAULT_APP_ROLE } from './boundary/configuration.js';
import { databaseChecks, databaseNotConnected, type VerifyTarget } from './boundary/database.js';
import { repositoryChecks } from './boundary/repository.js';
import { MIGRATION_FILES } from './migrate.js';

export type Options = {
  target: VerifyTarget;
  envFile?: string;
  otherRef?: string;
  database: boolean;
  databaseUrlEnv: string;
  strict: boolean;
  json: boolean;
};

export class UsageError extends Error {}

export const USAGE = [
  'Usage: npm run db:verify-boundary -- [--target local|staging|production] [--env-file <file>]',
  '         [--other-ref <project-ref>] [--database] [--database-url-env NAME] [--strict] [--json]',
].join('\n');

const TARGETS: VerifyTarget[] = ['local', 'staging', 'production'];

export function parseArguments(argv: string[]): Options {
  const options: Options = { target: 'local', database: false, databaseUrlEnv: 'DATABASE_MIGRATE_URL', strict: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === '--target') {
      const target = value() as VerifyTarget;
      if (!TARGETS.includes(target)) throw new UsageError(`--target must be one of ${TARGETS.join(', ')}`);
      options.target = target;
    } else if (flag === '--env-file') options.envFile = value();
    else if (flag === '--other-ref') options.otherRef = value();
    else if (flag === '--database-url-env') {
      options.databaseUrlEnv = value();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(options.databaseUrlEnv)) throw new UsageError('--database-url-env takes an environment variable NAME, not a URL');
    } else if (flag === '--database') options.database = true;
    else if (flag === '--strict') options.strict = true;
    else if (flag === '--json') options.json = true;
    else throw new UsageError(`Unknown argument: ${flag}`);
  }
  if (options.envFile && options.target === 'local') throw new UsageError('--env-file needs --target staging or production (local configuration is checked by config:check)');
  if (options.otherRef && !options.envFile) throw new UsageError('--other-ref needs --env-file');
  return options;
}

function providerChecks(): Check[] {
  return [
    check('R1-PROVIDER-DATA-API', 'Supabase Data API switched off in the project settings', 'NOT_VERIFIED', [
      'provider setting: R1 makes no call to Supabase and cannot observe it',
      'verify with docs/deployment/staging-provisioning.md section C, step 5',
    ], 'provider-settings', false),
    check('R1-PROVIDER-AUTH-SETTINGS', 'Supabase Auth settings (sign-up off, asymmetric signing keys, Site URL, redirects)', 'NOT_VERIFIED', [
      'provider setting: R1 does not read or change Auth configuration and creates no users',
      'verify with docs/deployment/staging-provisioning.md section B2 and section C, step 6',
    ], 'provider-settings', false),
  ];
}

export type Summary = { counts: Record<Status, number>; failing: string[]; result: 'PASS' | 'FAIL'; exitCode: 0 | 1 };

export function summarize(checks: Check[], strict: boolean): Summary {
  const counts: Record<Status, number> = { PASS: 0, FAIL: 0, NOT_VERIFIED: 0, NOT_APPLICABLE: 0, INFO: 0 };
  for (const item of checks) counts[item.status] += 1;
  const failing = checks
    .filter((item) => item.status === 'FAIL' || (strict && item.required && item.status === 'NOT_VERIFIED'))
    .map((item) => item.id);
  return { counts, failing, result: failing.length ? 'FAIL' : 'PASS', exitCode: failing.length ? 1 : 0 };
}

export function formatReport(checks: Check[], summary: Summary, context: { options: Options; host: string | null }): string {
  const { options } = context;
  const lines = [
    'BizcaiaOS boundary verification (R1, read-only: no provisioning, migration, deployment, or database change)',
    `target=${options.target} configuration=${options.envFile ? 'supplied' : 'not supplied'} database=${context.host ? `host ${context.host}` : 'not connected'} strict=${options.strict}`,
  ];
  for (const item of checks) {
    lines.push(`[${item.status}] ${item.id}: ${item.title}`);
    for (const evidence of item.evidence) lines.push(`    ${evidence}`);
    if (item.remediation) lines.push(`    remediation: ${item.remediation}${item.status === 'NOT_VERIFIED' && !item.required ? ' (not required by --strict)' : ''}`);
  }
  const { counts } = summary;
  lines.push(`SUMMARY: PASS ${counts.PASS}, FAIL ${counts.FAIL}, NOT_VERIFIED ${counts.NOT_VERIFIED}, NOT_APPLICABLE ${counts.NOT_APPLICABLE}, INFO ${counts.INFO}`);
  lines.push(`RESULT: ${summary.result}${summary.failing.length ? ` (${summary.failing.join(', ')})` : ''}`);
  return lines.join('\n');
}

/** Last line of defence: no supplied secret value may reach the output, whatever a check wrote. */
export function redact(text: string, secrets: string[]): string {
  let output = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

function urlSecrets(raw: string): string[] {
  const secrets = [raw];
  try {
    const url = new URL(raw);
    if (url.password) secrets.push(url.password, decodeURIComponent(url.password));
  } catch {
    // not a URL: the raw value is still redacted
  }
  return secrets;
}

export type Dependencies = {
  root: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => string;
  log: (text: string) => void;
  runDatabaseChecks?: typeof databaseChecks;
};

export async function runVerifier(argv: string[], dependencies: Dependencies): Promise<0 | 1 | 2> {
  const { log } = dependencies;
  let options: Options;
  try {
    options = parseArguments(argv);
  } catch (failure) {
    log(`${failure instanceof Error ? failure.message : String(failure)}\n${USAGE}`);
    return 2;
  }

  const secrets: string[] = [];
  const repository = repositoryChecks(dependencies.root, MIGRATION_FILES);

  let configuration: Check[];
  if (options.envFile) {
    let contents: string;
    try {
      contents = dependencies.readFile(options.envFile);
    } catch {
      log(`cannot read --env-file\n${USAGE}`);
      return 2;
    }
    secrets.push(...configurationSecrets(contents));
    configuration = configurationChecks(contents, { target: options.target as 'staging' | 'production', otherRef: options.otherRef });
  } else {
    configuration = configurationNotSupplied();
  }

  let database: Check[];
  let host: string | null = null;
  if (options.database) {
    const url = dependencies.env[options.databaseUrlEnv]?.trim();
    if (!url) {
      log(`--database needs the connection in ${options.databaseUrlEnv}; nothing was contacted\n${USAGE}`);
      return 2;
    }
    secrets.push(...urlSecrets(url));
    try {
      host = new URL(url).hostname;
    } catch {
      log(`${options.databaseUrlEnv} is not a postgres:// URL; nothing was contacted`);
      return 2;
    }
    try {
      database = await (dependencies.runDatabaseChecks ?? databaseChecks)(url, {
        target: options.target,
        appRole: dependencies.env.POSTGRES_APP_USER?.trim() || DEFAULT_APP_ROLE,
        registered: MIGRATION_FILES,
        rls: repository.rls,
      });
    } catch (failure) {
      const code = (failure as { code?: unknown })?.code;
      log(redact(`the read-only database verification could not complete${typeof code === 'string' ? ` (${code})` : ''}; no change was made`, secrets));
      return 2;
    }
  } else {
    database = databaseNotConnected();
  }

  const checks = [...repository.checks, ...configuration, ...database, ...providerChecks()];
  const summary = summarize(checks, options.strict);
  const text = options.json
    ? JSON.stringify({ tool: 'R1 boundary verifier (read-only)', target: options.target, strict: options.strict,
        configuration: Boolean(options.envFile), database: host ? { host } : null, checks, summary }, null, 2)
    : formatReport(checks, summary, { options, host });
  log(redact(text, secrets));
  return summary.exitCode;
}

const invokedDirectly = process.argv[1]?.replaceAll('\\', '/').endsWith('/verifyBoundary.ts');
if (invokedDirectly) {
  runVerifier(process.argv.slice(2), {
    root: join(dirname(fileURLToPath(import.meta.url)), '..'),
    env: process.env,
    readFile: (path) => readFileSync(path, 'utf8'),
    log: (text) => console.log(text),
  }).then((code) => process.exit(code));
}
