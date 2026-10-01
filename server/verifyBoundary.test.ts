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

  it('offline mode opens no network or database connection (real database module, no stub)', async () => {
    const socket = vi.spyOn(net.Socket.prototype, 'connect');
    const client = vi.spyOn(pg.Client.prototype, 'connect');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const argv of [[], ['--json'], ['--target', 'production', '--env-file', 'f', '--strict']]) {
        const output: string[] = [];
        await runVerifier(argv, {
          root: ROOT,
          env: { DATABASE_MIGRATE_URL: DATABASE_URL_VALUE },
          readFile: () => toFile(syntheticConfig('production')),
          log: (text) => output.push(text),
        });
        expect(output.join('\n')).toContain('DATABASE_CONNECTION_REQUIRED');
      }
      expect(socket).not.toHaveBeenCalled();
      expect(client).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      socket.mockRestore();
      client.mockRestore();
      fetchSpy.mockRestore();
    }
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
    for (const forbidden of ['server/migrate.ts', 'server/loadEnv.ts', 'server/database.ts', 'server/provisionAppRole.ts', 'server/index.ts']) {
      expect(graph, forbidden).not.toContain(forbidden);
    }
    for (const path of graph) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source, path).not.toMatch(/loadEnv|runMigrations\(|dotenv/);
    }
    expect(readFileSync(join(ROOT, 'server/migrations/migrationManifest.ts'), 'utf8')).not.toMatch(/^\s*import\s/m);
  });
});
