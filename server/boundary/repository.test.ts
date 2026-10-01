import { describe, expect, it } from 'vitest';
import {
  checkAuthWiring,
  checkDataPath,
  checkMigration019,
  checkMigrationChain,
  checkRepositoryRls,
  deriveRlsModel,
  MIGRATION_019,
  type SourceFile,
} from './repository.js';

// Synthetic file lists and sources only.
const CHAIN = ['001_core_schema.sql', '002_rbac_rls.sql', '003_other.sql', MIGRATION_019.replace('019', '004')];
const MIGRATION_019_SQL = `
  -- comment
  revoke execute on all functions in schema public from public;
  alter default privileges
    revoke execute on functions from public;`;

describe('R1 repository: migration chain', () => {
  it('passes a contiguous, registered, present chain', () => {
    expect(checkMigrationChain(CHAIN, [...CHAIN, 'validate_sql.py']).status).toBe('VERIFIED');
  });

  it('detects gaps, order, duplicates, missing and unregistered files', () => {
    const gap = checkMigrationChain(['001_a.sql', '003_c.sql'], ['001_a.sql', '003_c.sql']);
    expect(gap.status).toBe('FAIL');
    expect(gap.evidence).toContain('position 2 holds 003_c.sql (expected number 002)');
    expect(checkMigrationChain(['002_b.sql', '001_a.sql'], ['001_a.sql', '002_b.sql']).status).toBe('FAIL');
    expect(checkMigrationChain(['001_a.sql', '001_a.sql'], ['001_a.sql']).evidence).toContain('registered twice: 001_a.sql');
    expect(checkMigrationChain(['001_a.sql', '002_b.sql'], ['001_a.sql']).evidence).toContain('registered but missing from database/: 002_b.sql');
    expect(checkMigrationChain(['001_a.sql'], ['001_a.sql', '002_b.sql']).evidence).toContain('in database/ but not registered: 002_b.sql');
  });
});

describe('R1 repository: Migration 019', () => {
  const chain = ['001_a.sql', MIGRATION_019];
  it('passes when 019 is registered, present, and still revokes PUBLIC execute', () => {
    expect(checkMigration019(chain, chain, MIGRATION_019_SQL).status).toBe('VERIFIED');
  });

  it('fails when 019 is absent, unregistered, or no longer revokes', () => {
    const absent = checkMigration019(['001_a.sql'], ['001_a.sql'], null);
    expect(absent.status).toBe('FAIL');
    expect(absent.evidence).toEqual([`${MIGRATION_019} is not registered in the migration chain`, `${MIGRATION_019} is missing from database/`]);
    expect(checkMigration019(['001_a.sql'], chain, MIGRATION_019_SQL).status).toBe('FAIL');
    const weakened = checkMigration019(chain, chain, 'revoke execute on all functions in schema public from public;');
    expect(weakened.evidence).toEqual([`${MIGRATION_019} no longer contains: alter default privileges revoke execute on functions from public`]);
  });
});

describe('R1 repository: RLS model', () => {
  const files = [
    { path: '001', content: 'alter table public.a enable row level security;\ncreate policy p1 on public.a for select using (true);\n-- create policy ghost on public.a' },
    { path: '002', content: 'ALTER TABLE b ENABLE ROW LEVEL SECURITY; create policy "p2" on b using (true); drop policy if exists p1 on public.a; create policy p1 on public.a using (false);' },
    { path: '003', content: 'alter table c enable row level security; alter table c disable row level security; drop policy p2 on public.b;' },
  ];

  it('replays create/drop policy and enable/disable RLS in chain order, ignoring comments', () => {
    const model = deriveRlsModel(files);
    expect([...model.tables].sort()).toEqual(['a', 'b']);
    expect([...model.policies].sort()).toEqual(['a.p1']);
    expect(checkRepositoryRls(model).status).toBe('VERIFIED');
  });

  it('fails on a policy whose table never enables RLS, or an empty model', () => {
    const inert = checkRepositoryRls({ tables: new Set(['a']), policies: new Set(['b.p']) });
    expect(inert.status).toBe('FAIL');
    expect(inert.evidence).toEqual(['policy on a table without RLS enabled: b.p']);
    expect(checkRepositoryRls({ tables: new Set(), policies: new Set() }).status).toBe('FAIL');
  });
});

describe('R1 repository: data path and Auth wiring', () => {
  const auth: SourceFile = {
    path: 'src/auth/supabaseAuth.ts',
    content: "import { createClient } from '@supabase/supabase-js';\nauth.signInWithPassword({ email, password });\nauth.signOut();",
  };
  const api: SourceFile = {
    path: 'server/auth.ts',
    content: 'createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URL)); const issuer = process.env.AUTH_ISSUER; const audience = process.env.AUTH_AUDIENCE; await jwtVerify(token, keySet, { issuer, audience });',
  };
  const ui: SourceFile = { path: 'src/api/operationsApi.ts', content: "fetch(`${apiBase}/ops/projects`); Array.from(rows);" };

  it('passes when Supabase is used for sign-in only and the API reaches data through PostgreSQL', () => {
    expect(checkDataPath([auth, api, ui]).status).toBe('VERIFIED');
    expect(checkAuthWiring([auth, api, ui]).status).toBe('VERIFIED');
  });

  it('fails when the Data API (or storage/functions) becomes an application data path', () => {
    const rest = checkDataPath([auth, api, { ...ui, content: "fetch(`${supabaseUrl}/rest/v1/properties`)" }]);
    expect(rest.status).toBe('FAIL');
    expect(rest.evidence).toEqual(['src/api/operationsApi.ts references a Supabase Data API, storage, realtime, or functions path']);
    expect(checkDataPath([{ ...auth, content: `${auth.content}\nclient.from('properties').select()` }]).evidence)
      .toEqual(['src/auth/supabaseAuth.ts uses a Supabase data, storage, realtime, or functions API']);
    expect(checkDataPath([auth, { ...ui, content: "import { createClient } from '@supabase/supabase-js';" }]).status).toBe('FAIL');
    expect(checkDataPath([auth, { ...api, content: "import { createClient } from '@supabase/supabase-js';" }]).evidence)
      .toEqual(['server/auth.ts imports a Supabase client: the API must reach data through PostgreSQL']);
  });

  it('fails when token verification stops using the configured issuer/audience, or sign-up appears', () => {
    expect(checkAuthWiring([auth, { ...api, content: api.content.replace('{ issuer, audience }', '{}') }]).status).toBe('FAIL');
    expect(checkAuthWiring([{ ...auth, content: `${auth.content}\nauth.signUp({ email, password });` }, api]).evidence)
      .toEqual(['src/auth/supabaseAuth.ts calls signUp']);
  });
});
