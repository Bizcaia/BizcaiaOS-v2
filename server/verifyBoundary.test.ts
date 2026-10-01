import { readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { syntheticConfig, toFile } from './boundary/syntheticConfig.fixture.js';
import type { Check } from './boundary/checks.js';
import { parseArguments, redact, runVerifier, summarize, UsageError, type Dependencies } from './verifyBoundary.js';

// The CLI end to end against this checkout's repository files and synthetic
// configuration; the database is a stub. Nothing is contacted.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'synthetic-password-never-printed';
const DATABASE_URL_VALUE = `postgresql://verifier:${PASSWORD}@db.synthetic.test:5432/postgres`;

const passing = (id: string): Check => ({ id, title: id, status: 'VERIFIED', evidence: ['synthetic'], required: true });

async function cli(argv: string[], overrides: Partial<Dependencies> = {}) {
  const output: string[] = [];
  const code = await runVerifier(argv, {
    root: ROOT,
    env: {},
    readFile: () => toFile(syntheticConfig('staging')),
    log: (text) => output.push(text),
    runDatabaseChecks: async () => [passing('R1-DB-STUB')],
    ...overrides,
  });
  return { code, output: output.join('\n') };
}

describe('R1 verifier CLI', () => {
  it('exit 0: clean offline repository and configuration; database reported NOT_VERIFIED, not failed', async () => {
    const { code, output } = await cli(['--target', 'staging', '--env-file', 'staging.env']);
    expect(code).toBe(0);
    expect(output).toContain('[VERIFIED] R1-CFG-PROJECT');
    expect(output).toContain('[NOT_VERIFIED] R1-DB-RLS');
    expect(output).toContain('NOT_VERIFIED — DATABASE_CONNECTION_REQUIRED');
    expect(output).toContain('RESULT: NO_FINDINGS');
  });

  it('exit 1: a boundary violation fails', async () => {
    const bad = syntheticConfig('staging');
    bad.api.DATABASE_MIGRATE_URL = bad.migration.DATABASE_MIGRATE_URL;
    const { code, output } = await cli(['--target', 'staging', '--env-file', 'f'], { readFile: () => toFile(bad) });
    expect(code).toBe(1);
    expect(output).toMatch(/RESULT: FINDINGS \(.*R1-CFG-MIGRATION-SEPARATION/);
  });

  it('exit 1 with --strict when a required check could not be verified', async () => {
    const { code, output } = await cli(['--target', 'staging', '--env-file', 'f', '--strict']);
    expect(code).toBe(1);
    expect(output).toContain('R1-DB-IDENTITY');
    expect(output).not.toMatch(/RESULT: FINDINGS \(.*R1-PROVIDER-DATA-API/);
    // With configuration and a database, strict passes: provider checks are manual and never required.
    expect((await cli(['--target', 'staging', '--env-file', 'f', '--database', '--strict'], { env: { DATABASE_MIGRATE_URL: DATABASE_URL_VALUE } })).code).toBe(0);
  });

  it('exit 2: usage and configuration errors, with nothing contacted', async () => {
    let contacted = false;
    const runDatabaseChecks = async () => {
      contacted = true;
      return [];
    };
    for (const argv of [
      ['--target', 'qa'],
      ['--env-file', 'f'],
      ['--other-ref', 'x'],
      ['--database-url-env', 'postgresql://inline'],
      ['--unknown'],
      ['--target'],
    ]) {
      const { code, output } = await cli(argv, { runDatabaseChecks });
      expect(code, argv.join(' ')).toBe(2);
      expect(output).toContain('Usage: npm run db:verify-boundary');
    }
    expect((await cli(['--target', 'staging', '--env-file', 'missing'], { readFile: () => { throw new Error('ENOENT'); } })).code).toBe(2);
    expect(contacted).toBe(false);
  });

  it('unavailable database connection: NOT_VERIFIED without --database; exit 2 when requested but missing or failing', async () => {
    const offline = await cli([]);
    expect(offline.code).toBe(0);
    expect(offline.output).toContain('database=not connected');
    const missing = await cli(['--database']);
    expect(missing.code).toBe(2);
    expect(missing.output).toContain('--database needs the connection in DATABASE_MIGRATE_URL; nothing was contacted');
    const refused = await cli(['--database'], {
      env: { DATABASE_MIGRATE_URL: DATABASE_URL_VALUE },
      runDatabaseChecks: async () => { throw Object.assign(new Error(`connect failed for ${DATABASE_URL_VALUE}`), { code: 'ECONNREFUSED' }); },
    });
    expect(refused.code).toBe(2);
    expect(refused.output).toBe('the read-only database verification could not complete (ECONNREFUSED); no change was made');
  });

  it('uses only the variable named by --database-url-env', async () => {
    const seen: string[] = [];
    const { code, output } = await cli(['--database', '--database-url-env', 'VERIFY_DATABASE_URL'], {
      env: { DATABASE_MIGRATE_URL: 'postgresql://ignored@ignored.test/x', VERIFY_DATABASE_URL: DATABASE_URL_VALUE },
      runDatabaseChecks: async (url) => { seen.push(url); return [passing('R1-DB-STUB')]; },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([DATABASE_URL_VALUE]);
    expect(output).toContain('database=host db.synthetic.test');
  });

  it('never prints secret values, in text or JSON, even if a check tried to', async () => {
    const config = syntheticConfig('staging');
    config.frontend.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_secret_synthetic_value';
    const leaky = async () => [{ ...passing('R1-DB-STUB'), evidence: [`oops ${DATABASE_URL_VALUE}`, `and ${PASSWORD}`] }];
    for (const extra of [[], ['--json']]) {
      const { output } = await cli(['--target', 'staging', '--env-file', 'f', '--database', ...extra], {
        readFile: () => toFile(config),
        env: { DATABASE_MIGRATE_URL: DATABASE_URL_VALUE },
        runDatabaseChecks: leaky,
      });
      for (const secret of [PASSWORD, DATABASE_URL_VALUE, 'sb_secret_synthetic_value', 'synthetic-password']) expect(output).not.toContain(secret);
      expect(output).toContain('[REDACTED]');
    }
  });

  it('emits machine-readable JSON with every check, status, evidence, and remediation', async () => {
    const { output } = await cli(['--json']);
    const report = JSON.parse(output);
    expect(report.tool).toBe('R1 boundary verifier (read-only)');
    expect(report.summary.result).toBe('NO_FINDINGS');
    const cfg = report.checks.find((item: Check) => item.id === 'R1-CFG-CONTRACT');
    expect(cfg).toMatchObject({ status: 'NOT_VERIFIED', remediation: 'configuration', required: true });
  });

  it('parses arguments and summarizes deterministically', () => {
    expect(parseArguments([])).toEqual({ target: 'local', database: false, databaseUrlEnv: 'DATABASE_MIGRATE_URL', strict: false, json: false });
    expect(() => parseArguments(['--env-file', 'x', '--target', 'local'])).toThrow(UsageError);
    const checks: Check[] = [passing('A'), { ...passing('B'), status: 'NOT_VERIFIED' }, { ...passing('C'), status: 'NOT_VERIFIED', required: false }];
    expect(summarize(checks, false)).toMatchObject({ result: 'NO_FINDINGS', exitCode: 0, failing: [] });
    expect(summarize(checks, true)).toMatchObject({ result: 'FINDINGS', exitCode: 1, failing: ['B'] });
    expect(redact('a secret b', ['secret'])).toBe('a [REDACTED] b');
  });

  /** Blocks and records every network/database connection attempt for the duration of `run`. */
  async function withConnectionsBlocked<T>(run: (attempts: string[]) => Promise<T>): Promise<T> {
    const attempts: string[] = [];
    const block = (kind: string) => () => {
      attempts.push(kind);
      throw Object.assign(new Error(`R1 test: ${kind} blocked`), { code: 'R1_TEST_BLOCKED' });
    };
    const spies = [
      vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(block('socket') as never),
      vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(block('pg.Client.connect') as never),
      vi.spyOn(globalThis, 'fetch').mockImplementation(block('fetch') as never),
    ];
    try {
      return await run(attempts);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  it('offline mode makes no network or database connection, and the offline checks still run (real database module, no stub)', async () => {
    await withConnectionsBlocked(async (attempts) => {
      for (const argv of [[], ['--json'], ['--target', 'staging', '--env-file', 'f'], ['--target', 'production', '--env-file', 'f', '--strict']]) {
        const output: string[] = [];
        await runVerifier(argv, {
          root: ROOT,
          // A connection string is present on purpose: offline mode must still not use it.
          env: { DATABASE_MIGRATE_URL: DATABASE_URL_VALUE },
          readFile: () => toFile(syntheticConfig(argv.includes('production') ? 'production' : 'staging')),
          log: (text) => output.push(text),
        });
        const text = output.join('\n');
        expect(text, argv.join(' ')).toContain('DATABASE_CONNECTION_REQUIRED');
        expect(text, argv.join(' ')).toMatch(/R1-REPO-MIGRATION-CHAIN/);
        if (argv.includes('--env-file')) expect(text).toMatch(/\[VERIFIED\] R1-CFG-PROJECT/);
      }
      expect(attempts).toEqual([]);
    });
  });

  it('the offline guard is sensitive: a database run is caught as a connection attempt', async () => {
    await withConnectionsBlocked(async (attempts) => {
      const output: string[] = [];
      const code = await runVerifier(['--database'], {
        root: ROOT,
        env: { DATABASE_MIGRATE_URL: DATABASE_URL_VALUE },
        readFile: () => '',
        log: (text) => output.push(text),
      });
      expect(attempts).toContain('pg.Client.connect');
      expect(code).toBe(2);
      expect(output.join('\n')).toBe('the read-only database verification could not complete (R1_TEST_BLOCKED); no change was made');
    });
  });

  it('import safety: R1 never imports the migration runner or any module that loads .env', () => {
    const graph = new Set<string>();
    const pending = [join(ROOT, 'server', 'verifyBoundary.ts')];
    while (pending.length) {
      const file = pending.pop()!;
      const path = relative(ROOT, file).replaceAll('\\', '/');
      if (graph.has(path)) continue;
      graph.add(path);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:^\s*(?:import|export)\s[^'";]*?from\s*|^\s*import\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        pending.push(resolve(dirname(file), match[1].replace(/\.js$/, '.ts')));
      }
    }
    // The walk really traverses: it reaches modules two levels down.
    for (const reached of ['server/migrations/migrationManifest.ts', 'server/boundary/database.ts', 'server/config/environmentContract.ts']) {
      expect(graph).toContain(reached);
    }
    for (const forbidden of [
      'server/migrate.ts', // migration runner (also loads .env)
      'server/loadEnv.ts', // .env loading
      'server/database.ts', // API connection pool and transactions
      'server/provisionAppRole.ts', // creates roles
      'server/index.ts', 'server/routes.ts', 'server/operationsRoutes.ts', 'server/auth.ts', // API runtime
      'server/storage/documentStorage.ts', 'server/storage/localDiskDocumentStorage.ts', // file writes
    ]) {
      expect(graph, forbidden).not.toContain(forbidden);
    }
    for (const path of graph) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source, path).not.toMatch(/loadEnv|runMigrations\(|dotenv/);
    }
    expect(readFileSync(join(ROOT, 'server/migrations/migrationManifest.ts'), 'utf8')).not.toMatch(/^\s*import\s/m);
  });
});
