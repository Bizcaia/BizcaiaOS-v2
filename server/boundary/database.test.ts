import { describe, expect, it } from 'vitest';
import { MIGRATION_FILES } from '../migrations/migrationManifest.js';
import type { Check } from './checks.js';
import { collectSnapshot, evaluate, QUERIES, TRANSACTION, TRUSTED_FUNCTIONS, withReadOnlySession, type Snapshot, type VerifyTarget } from './database.js';
import type { RlsModel } from './repository.js';

// Synthetic catalog snapshots only; no database.
const OWNER = 'bizcaiaos_migrator';
const APP = 'bizcaiaos_app';
const FUNCTIONS = ['current_app_user_id()', 'can_read_property(uuid)', ...TRUSTED_FUNCTIONS.map((name) => `${name}(text)`)];
const TABLES = ['properties', 'documents'];
const RLS: RlsModel = { tables: new Set(TABLES), policies: new Set(['properties.properties_select_visible', 'documents.documents_select_visible']) };
const CRUD = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const role = (name: string, extra: Partial<Snapshot['roles'][number]> = {}) =>
  ({ name, login: true, superuser: false, bypassRls: false, createRole: false, createDb: false, ...extra });

function cleanSnapshot(): Snapshot {
  const relations = [
    ...TABLES.map((name) => ({ name, kind: 'r', owner: OWNER, rls: true })),
    { name: 'schema_migrations', kind: 'r', owner: OWNER, rls: false },
  ];
  return {
    identity: { database: 'postgres', user: OWNER, version: 'PostgreSQL 17.6 on x86_64', publicSchema: true, readOnly: true },
    appRole: APP,
    roles: [role(APP), role(OWNER)],
    memberships: [],
    subscriptionDatabases: { app: [], acting: [] },
    migrations: [...MIGRATION_FILES],
    relations,
    functions: FUNCTIONS.map((signature) => ({ signature, name: signature.split('(')[0], owner: OWNER, extension: null })),
    relationPrivileges: {
      public: Object.fromEntries(relations.map((rel) => [rel.name, []])),
      [APP]: { ...Object.fromEntries(TABLES.map((name) => [name, CRUD])), schema_migrations: [] },
    },
    functionExecute: {
      public: Object.fromEntries(FUNCTIONS.map((fn) => [fn, false])),
      [APP]: Object.fromEntries(FUNCTIONS.map((fn) => [fn, true])),
    },
    schemaPrivileges: { public: { usage: true, canCreate: false }, [APP]: { usage: true, canCreate: false } },
    extensions: [{ name: 'pgcrypto', schema: 'extensions' }],
    policies: [
      { table: 'properties', name: 'properties_select_visible', functions: ['can_read_property'] },
      { table: 'documents', name: 'documents_select_visible', functions: ['current_app_user_id'] },
    ],
    defaultAcls: [
      { role: OWNER, schema: '(all schemas)', type: 'f', grantee: OWNER, privilege: 'EXECUTE' },
      { role: OWNER, schema: 'public', type: 'f', grantee: APP, privilege: 'EXECUTE' },
    ],
    trustedGrants: TRUSTED_FUNCTIONS.flatMap((fn) => [{ function: fn, grantee: OWNER }, { function: fn, grantee: APP }]),
  };
}

/** Supabase-like: anon/authenticated/service_role present, holding nothing BizcaiaOS; provider defaults recorded. */
function supabaseSnapshot(): Snapshot {
  const base = cleanSnapshot();
  const none = () => Object.fromEntries([...TABLES, 'schema_migrations'].map((name) => [name, []]));
  const noExec = () => Object.fromEntries(FUNCTIONS.map((fn) => [fn, false]));
  return {
    ...base,
    roles: [...base.roles, role('anon', { login: false }), role('authenticated', { login: false }), role('service_role', { login: false, bypassRls: true })],
    relationPrivileges: { ...base.relationPrivileges, anon: none(), authenticated: none(), service_role: none() },
    functionExecute: { ...base.functionExecute, anon: noExec(), authenticated: noExec(), service_role: noExec() },
    defaultAcls: [...base.defaultAcls, { role: 'postgres', schema: 'public', type: 'r', grantee: 'anon', privilege: 'TRUNCATE' }],
  };
}

const run = (snapshot: Snapshot, target: VerifyTarget = 'staging') => evaluate(snapshot, { target, registered: MIGRATION_FILES, rls: RLS });
const statusOf = (checks: Check[]) => Object.fromEntries(checks.map((item) => [item.id, item.status]));
const failed = (checks: Check[]) => checks.filter((item) => item.status === 'FAIL').map((item) => item.id);
const evidence = (checks: Check[], id: string) => checks.find((item) => item.id === id)!.evidence.join('\n');

describe('R1 database evaluation (synthetic snapshots)', () => {
  it('passes a clean Supabase-like staging snapshot and records provider defaults', () => {
    const checks = run(supabaseSnapshot());
    expect(failed(checks)).toEqual([]);
    expect(statusOf(checks)).toMatchObject({
      'R1-DB-IDENTITY': 'VERIFIED', 'R1-DB-ROLES': 'VERIFIED', 'R1-DB-APP-MEMBERSHIP': 'VERIFIED', 'R1-DB-MIGRATIONS': 'VERIFIED', 'R1-DB-OWNER': 'VERIFIED', 'R1-DB-APP-PRIVILEGES': 'VERIFIED',
      'R1-DB-PUBLIC': 'VERIFIED', 'R1-DB-ANON': 'VERIFIED', 'R1-DB-AUTHENTICATED': 'VERIFIED', 'R1-DB-FUTURE-FUNCTIONS': 'VERIFIED',
      'R1-DB-TRUSTED-FUNCTIONS': 'VERIFIED', 'R1-DB-RLS': 'VERIFIED', 'R1-DB-DEFAULT-ACLS': 'INFO', 'R1-DB-SERVICE-ROLE': 'INFO',
    });
    expect(evidence(checks, 'R1-DB-ANON')).toContain('provider default in public (applies only to objects that role creates): postgres r');
  });

  it('reports anon/authenticated as not applicable on plain PostgreSQL', () => {
    const local = { ...cleanSnapshot(), identity: { ...cleanSnapshot().identity, user: 'local_owner' }, roles: [role(APP)] };
    for (const rel of local.relations) rel.owner = 'local_owner';
    for (const fn of local.functions) fn.owner = 'local_owner';
    local.defaultAcls = local.defaultAcls.map((acl) => ({ ...acl, role: 'local_owner', grantee: acl.grantee === OWNER ? 'local_owner' : acl.grantee }));
    local.trustedGrants = local.trustedGrants.map((grant) => ({ ...grant, grantee: grant.grantee === OWNER ? 'local_owner' : grant.grantee }));
    const checks = run(local, 'local');
    expect(failed(checks)).toEqual([]);
    expect(statusOf(checks)).toMatchObject({ 'R1-DB-ANON': 'NOT_APPLICABLE', 'R1-DB-AUTHENTICATED': 'NOT_APPLICABLE', 'R1-DB-OWNER': 'VERIFIED' });
    // The same database judged as staging must connect as, and be owned by, bizcaiaos_migrator.
    expect(failed(run(local, 'staging'))).toEqual(expect.arrayContaining(['R1-DB-IDENTITY', 'R1-DB-ROLES', 'R1-DB-OWNER']));
  });

  it('negative control: a PUBLIC execute grant on a BizcaiaOS function fails (good state passes)', () => {
    const snapshot = supabaseSnapshot();
    expect(statusOf(run(snapshot))['R1-DB-PUBLIC']).toBe('VERIFIED');
    snapshot.functionExecute.public['can_read_property(uuid)'] = true;
    const checks = run(snapshot);
    expect(failed(checks)).toEqual(['R1-DB-PUBLIC']);
    expect(evidence(checks, 'R1-DB-PUBLIC')).toContain('PUBLIC can execute: can_read_property(uuid)');
  });

  it('fails when the application role loses a privilege the API needs', () => {
    const table = supabaseSnapshot();
    table.relationPrivileges[APP].documents = ['SELECT'];
    expect(failed(run(table))).toEqual(['R1-DB-APP-PRIVILEGES']);
    const helper = supabaseSnapshot();
    helper.functionExecute[APP]['current_app_user_id()'] = false;
    expect(failed(run(helper))).toEqual(['R1-DB-APP-PRIVILEGES']);
    const migrations = supabaseSnapshot();
    migrations.relationPrivileges[APP].schema_migrations = ['SELECT'];
    expect(evidence(run(migrations), 'R1-DB-APP-PRIVILEGES')).toContain('has privileges on schema_migrations');
  });

  it('fails on role attributes outside the accepted boundary', () => {
    const snapshot = supabaseSnapshot();
    snapshot.roles = snapshot.roles.map((entry) => (entry.name === APP ? { ...entry, bypassRls: true, createDb: true } : entry.name === OWNER ? { ...entry, createRole: true } : entry));
    const checks = run(snapshot);
    expect(failed(checks)).toEqual(['R1-DB-ROLES']);
    expect(evidence(checks, 'R1-DB-ROLES')).toMatch(/bizcaiaos_app: CREATEDB[\s\S]*bizcaiaos_app: BYPASSRLS[\s\S]*bizcaiaos_migrator: CREATEROLE/);
  });

  describe('application role memberships (R1-DB-APP-MEMBERSHIP)', () => {
    const member = (roleName: string, extra: Partial<Snapshot['memberships'][number]> = {}) =>
      ({ role: roleName, path: [roleName], inherit: true, setOption: true, admin: false, superuser: false, bypassRls: false, ...extra });
    const withMemberships = (...memberships: Snapshot['memberships']) => ({ ...supabaseSnapshot(), memberships });

    it('passes with no membership, and records that it read pg_auth_members', () => {
      const checks = run(withMemberships());
      expect(statusOf(checks)['R1-DB-APP-MEMBERSHIP']).toBe('VERIFIED');
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toContain('bizcaiaos_app is a member of no role');
    });

    it.each([
      [true, true],
      [false, true],
      [true, false],
      [false, false],
    ])('fails on membership in the migration owner with INHERIT %s / SET %s', (inherit, setOption) => {
      const checks = run(withMemberships(member(OWNER, { inherit, setOption })));
      expect(failed(checks)).toEqual(['R1-DB-APP-MEMBERSHIP']);
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toContain(
        `bizcaiaos_app is a member of bizcaiaos_migrator via bizcaiaos_migrator (inherit=${inherit} set=${setOption} admin=false): the migration owner`,
      );
    });

    it.each([
      [true, true, "bizcaiaos_app inherits this role's privileges and can SET ROLE to it"],
      [true, false, "bizcaiaos_app inherits this role's privileges but cannot SET ROLE to it"],
      [false, true, 'bizcaiaos_app can SET ROLE to it but does not inherit its privileges'],
      [false, false, 'bizcaiaos_app neither inherits its privileges nor can SET ROLE to it today; the membership is still forbidden, because widening its options would open both'],
    ])('states what INHERIT %s / SET %s allows, without overstating it', (inherit, setOption, consequence) => {
      const text = evidence(run(withMemberships(member(OWNER, { inherit, setOption }))), 'R1-DB-APP-MEMBERSHIP');
      expect(text).toBe(`bizcaiaos_app is a member of bizcaiaos_migrator via bizcaiaos_migrator (inherit=${inherit} set=${setOption} admin=false): the migration owner; ${consequence}`);
      expect(text).not.toContain('a member can use its privileges or SET ROLE');
    });

    it.each([
      [false, false, 'bizcaiaos_app neither inherits its privileges nor can SET ROLE to it through this grant, but with ADMIN, bizcaiaos_app can grant this role to itself or other roles with any INHERIT and SET options, which opens both'],
      [false, true, 'bizcaiaos_app can SET ROLE to it but does not inherit its privileges; with ADMIN, bizcaiaos_app can grant this role to itself or other roles with any INHERIT and SET options'],
      [true, false, "bizcaiaos_app inherits this role's privileges but cannot SET ROLE to it; with ADMIN, bizcaiaos_app can grant this role to itself or other roles with any INHERIT and SET options"],
      [true, true, "bizcaiaos_app inherits this role's privileges and can SET ROLE to it; with ADMIN, bizcaiaos_app can grant this role to itself or other roles with any INHERIT and SET options"],
    ])('states that ADMIN lets the member re-grant the role (INHERIT %s / SET %s)', (inherit, setOption, consequence) => {
      const checks = run(withMemberships(member(OWNER, { inherit, setOption, admin: true })));
      expect(failed(checks)).toEqual(['R1-DB-APP-MEMBERSHIP']);
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toBe(
        `bizcaiaos_app is a member of bizcaiaos_migrator via bizcaiaos_migrator (inherit=${inherit} set=${setOption} admin=true): the migration owner; ${consequence}`,
      );
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).not.toContain('today');
    });

    it('does not claim ADMIN on a SUPERUSER role can be used, since only a superuser may grant one', () => {
      const text = evidence(run(withMemberships(member('ops_admin', { superuser: true, inherit: false, setOption: false, admin: true }))), 'R1-DB-APP-MEMBERSHIP');
      expect(text).toBe(
        'bizcaiaos_app is a member of ops_admin via ops_admin (inherit=false set=false admin=true): SUPERUSER; ' +
          'bizcaiaos_app neither inherits its privileges nor can SET ROLE to it today; the membership is still forbidden, because widening its options would open both; ' +
          'its ADMIN option is unusable unless the holder is a superuser, because only superusers may grant a SUPERUSER role',
      );
      expect(text).not.toContain('can grant this role to itself');
    });

    it('states ADMIN on the last link of a nested path, and on servers before PostgreSQL 16', () => {
      const nested = run(withMemberships(member('ops_group'), member(OWNER, { path: ['ops_group', OWNER], inherit: false, setOption: false, admin: true })));
      expect(evidence(nested, 'R1-DB-APP-MEMBERSHIP')).toContain(
        'the membership is forbidden whatever the options; the last link carries ADMIN, so ops_group can grant bizcaiaos_migrator to any role, including bizcaiaos_app, with any options',
      );
      const pre16 = run(withMemberships(member(OWNER, { inherit: null, setOption: null, admin: true })));
      expect(evidence(pre16, 'R1-DB-APP-MEMBERSHIP')).toContain(
        '(inherit=n/a set=n/a admin=true): the migration owner; INHERIT and SET are not recorded per membership before PostgreSQL 16, where any member can SET ROLE to the role; with ADMIN, bizcaiaos_app can also grant the role to other roles',
      );
    });

    it('fails on NOINHERIT + SET even though every effective privilege check still passes', () => {
      const snapshot = withMemberships(member(OWNER, { inherit: false, setOption: true }));
      // The privilege view is exactly the clean one: has_table_privilege shows nothing new.
      expect(snapshot.relationPrivileges[APP]).toEqual(supabaseSnapshot().relationPrivileges[APP]);
      expect(statusOf(run(snapshot))).toMatchObject({ 'R1-DB-APP-PRIVILEGES': 'VERIFIED', 'R1-DB-PUBLIC': 'VERIFIED', 'R1-DB-APP-MEMBERSHIP': 'FAIL' });
    });

    it('fails on a nested membership that reaches the migration owner', () => {
      const checks = run(withMemberships(member('ops_group'), member(OWNER, { path: ['ops_group', OWNER], inherit: false })));
      expect(failed(checks)).toEqual(['R1-DB-APP-MEMBERSHIP']);
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toContain('via ops_group -> bizcaiaos_migrator');
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).not.toContain('member of ops_group via');
    });

    it('labels nested options as those of the last link, not of the whole path', () => {
      const checks = run(withMemberships(
        member('ops_group', { inherit: true, setOption: true }),
        member('team_leads', { path: ['ops_group', 'team_leads'] }),
        member(OWNER, { path: ['ops_group', 'team_leads', OWNER], inherit: false, setOption: true }),
      ));
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toBe(
        'bizcaiaos_app is a member of bizcaiaos_migrator via ops_group -> team_leads -> bizcaiaos_migrator ' +
          '(last link team_leads -> bizcaiaos_migrator: inherit=false set=true admin=false): the migration owner; ' +
          'nested: what the application role can do depends on every link in the path; the membership is forbidden whatever the options',
      );
    });

    it.each(['pg_read_all_data', 'pg_write_all_data', 'pg_execute_server_program'])('fails on membership in %s', (predefined) => {
      const checks = run(withMemberships(member(predefined)));
      expect(failed(checks)).toEqual(['R1-DB-APP-MEMBERSHIP']);
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toContain(`member of ${predefined} via ${predefined}`);
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toContain('privileged predefined role');
    });

    describe('pg_maintain and pg_create_subscription (C5)', () => {
      const MAINTAIN = 'VACUUM, ANALYZE, REINDEX, REFRESH MATERIALIZED VIEW and LOCK TABLE on every relation, without reading or writing its data (PostgreSQL 17+)';
      const SUBSCRIBE = 'subscriptions make the server connect out to a host the subscriber names (PostgreSQL 16+); CREATE SUBSCRIPTION also needs CREATE on the database, checked for the acting role: ';
      const NO_DATABASE = 'no database bizcaiaos_app can connect to';
      const HERE = 'postgres (current)';
      // Finding no path is not proof of absence, so the evidence never says "cannot".
      const NONE_FOUND = 'none of the roles bizcaiaos_app can act as (itself, or through SET ROLE) holds both the privileges of pg_create_subscription and CREATE on a database bizcaiaos_app can connect to; ' +
        'routes other than role switching, such as SECURITY DEFINER functions, are not evaluated';
      const direct = (options: string, allows: string) => `bizcaiaos_app is a member of pg_create_subscription via pg_create_subscription (${options}): privileged predefined role; ${allows}; `;
      const BOTH = "bizcaiaos_app inherits this role's privileges and can SET ROLE to it";
      const NESTED = 'nested: what the application role can do depends on every link in the path; the membership is forbidden whatever the options; ';
      // `acting` is what the catalog query returns (verified against PostgreSQL in the integration test).
      const withSubscription = (databases: Partial<Snapshot['subscriptionDatabases']>, ...memberships: Snapshot['memberships']) =>
        ({ ...withMemberships(...memberships), subscriptionDatabases: { app: [], acting: [], ...databases } });

      it.each([
        [true, true, "bizcaiaos_app inherits this role's privileges and can SET ROLE to it"],
        [false, true, 'bizcaiaos_app can SET ROLE to it but does not inherit its privileges'],
        [true, false, "bizcaiaos_app inherits this role's privileges but cannot SET ROLE to it"],
        [false, false, 'bizcaiaos_app neither inherits its privileges nor can SET ROLE to it today; the membership is still forbidden, because widening its options would open both'],
      ])('fails on pg_maintain with INHERIT %s / SET %s and states what it allows', (inherit, setOption, consequence) => {
        const checks = run(withMemberships(member('pg_maintain', { inherit, setOption })));
        expect(failed(checks)).toEqual(['R1-DB-APP-MEMBERSHIP']);
        expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toBe(
          `bizcaiaos_app is a member of pg_maintain via pg_maintain (inherit=${inherit} set=${setOption} admin=false): privileged predefined role; ${consequence}; ${MAINTAIN}`,
        );
      });

      it('fails on pg_maintain held with ADMIN only, and through a nested path', () => {
        expect(evidence(run(withMemberships(member('pg_maintain', { inherit: false, setOption: false, admin: true }))), 'R1-DB-APP-MEMBERSHIP')).toBe(
          'bizcaiaos_app is a member of pg_maintain via pg_maintain (inherit=false set=false admin=true): privileged predefined role; ' +
            'bizcaiaos_app neither inherits its privileges nor can SET ROLE to it through this grant, but with ADMIN, bizcaiaos_app can grant this role to itself or other roles with any INHERIT and SET options, which opens both; ' +
            MAINTAIN,
        );
        const nested = run(withMemberships(member('ops_group'), member('pg_maintain', { path: ['ops_group', 'pg_maintain'] })));
        expect(failed(nested)).toEqual(['R1-DB-APP-MEMBERSHIP']);
        expect(evidence(nested, 'R1-DB-APP-MEMBERSHIP')).toBe(
          'bizcaiaos_app is a member of pg_maintain via ops_group -> pg_maintain (last link ops_group -> pg_maintain: inherit=true set=true admin=false): privileged predefined role; ' +
            `nested: what the application role can do depends on every link in the path; the membership is forbidden whatever the options; ${MAINTAIN}`,
        );
      });

      it('fails on pg_create_subscription without CREATE on any database, and states that no path was found without claiming none exists', () => {
        const checks = run(withSubscription({}, member('pg_create_subscription')));
        expect(failed(checks)).toEqual(['R1-DB-APP-MEMBERSHIP']);
        expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toBe(`${direct('inherit=true set=true admin=false', BOTH)}${SUBSCRIBE}bizcaiaos_app holds CREATE on ${NO_DATABASE}; ${NONE_FOUND}`);
        expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).not.toContain('cannot create');
      });

      it('direct inherited membership plus CREATE: the application role can create subscriptions as itself', () => {
        expect(evidence(run(withSubscription({ app: [HERE], acting: [{ role: APP, database: HERE }] }, member('pg_create_subscription'))), 'R1-DB-APP-MEMBERSHIP')).toBe(
          `${direct('inherit=true set=true admin=false', BOTH)}${SUBSCRIBE}bizcaiaos_app holds CREATE on ${HERE}; bizcaiaos_app can create subscriptions now: as itself in ${HERE}`,
        );
      });

      it('does not flag CREATE on the database without the membership', () => {
        const checks = run(withSubscription({ app: [HERE] }));
        expect(failed(checks)).toEqual([]);
        expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toBe('bizcaiaos_app is a member of no role\nread from pg_auth_members, whatever the INHERIT and SET options');
      });

      it('direct SET only: CREATE held by the application role is no path; CREATE held by pg_create_subscription is one, after SET ROLE', () => {
        const setOnly = member('pg_create_subscription', { inherit: false, setOption: true });
        const SET_ONLY = 'bizcaiaos_app can SET ROLE to it but does not inherit its privileges';
        expect(evidence(run(withSubscription({ app: [HERE] }, setOnly)), 'R1-DB-APP-MEMBERSHIP')).toBe(
          `${direct('inherit=false set=true admin=false', SET_ONLY)}${SUBSCRIBE}bizcaiaos_app holds CREATE on ${HERE}; ${NONE_FOUND}`,
        );
        expect(evidence(run(withSubscription({ acting: [{ role: 'pg_create_subscription', database: HERE }] }, setOnly)), 'R1-DB-APP-MEMBERSHIP')).toBe(
          `${direct('inherit=false set=true admin=false', SET_ONLY)}${SUBSCRIBE}bizcaiaos_app holds CREATE on ${NO_DATABASE}; bizcaiaos_app can create subscriptions now: after SET ROLE pg_create_subscription in ${HERE}`,
        );
        // Neither INHERIT nor SET: still a finding.
        const neither = run(withSubscription({ app: [HERE] }, member('pg_create_subscription', { inherit: false, setOption: false })));
        expect(failed(neither)).toEqual(['R1-DB-APP-MEMBERSHIP']);
        expect(evidence(neither, 'R1-DB-APP-MEMBERSHIP').endsWith(NONE_FOUND)).toBe(true);
      });

      // N1 and N2 reproduced on PostgreSQL 16, 17 and 18: a subscription is created through a nested SET ROLE path.
      it('N1: SET ROLE to an intermediate role that inherits pg_create_subscription and holds CREATE is a path', () => {
        const checks = run(withSubscription({ acting: [{ role: 'ops_group', database: HERE }] },
          member('ops_group', { inherit: false, setOption: true }), member('pg_create_subscription', { path: ['ops_group', 'pg_create_subscription'] })));
        expect(failed(checks)).toEqual(['R1-DB-APP-MEMBERSHIP']);
        expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toBe(
          'bizcaiaos_app is a member of pg_create_subscription via ops_group -> pg_create_subscription (last link ops_group -> pg_create_subscription: inherit=true set=true admin=false): privileged predefined role; ' +
            `${NESTED}${SUBSCRIBE}bizcaiaos_app holds CREATE on ${NO_DATABASE}; bizcaiaos_app can create subscriptions now: after SET ROLE ops_group in ${HERE}`,
        );
      });

      it('N2: a nested chain of SET options reaches pg_create_subscription itself, which holds CREATE', () => {
        const checks = run(withSubscription({ acting: [{ role: 'pg_create_subscription', database: HERE }] },
          member('ops_group'), member('pg_create_subscription', { path: ['ops_group', 'pg_create_subscription'], inherit: false, setOption: true })));
        expect(failed(checks)).toEqual(['R1-DB-APP-MEMBERSHIP']);
        expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toBe(
          'bizcaiaos_app is a member of pg_create_subscription via ops_group -> pg_create_subscription (last link ops_group -> pg_create_subscription: inherit=false set=true admin=false): privileged predefined role; ' +
            `${NESTED}${SUBSCRIBE}bizcaiaos_app holds CREATE on ${NO_DATABASE}; bizcaiaos_app can create subscriptions now: after SET ROLE pg_create_subscription in ${HERE}`,
        );
      });

      it('lists every path found, grouped by acting role', () => {
        const text = evidence(run(withSubscription({ app: [HERE, 'reporting'], acting: [
          { role: APP, database: HERE }, { role: APP, database: 'reporting' }, { role: 'ops_group', database: HERE },
        ] }, member('pg_create_subscription'))), 'R1-DB-APP-MEMBERSHIP');
        expect(text.endsWith(`bizcaiaos_app holds CREATE on ${HERE}, reporting; bizcaiaos_app can create subscriptions now: as itself in ${HERE}, reporting; after SET ROLE ops_group in ${HERE}`)).toBe(true);
      });

      it('ADMIN only: the existing ADMIN wording, and no path through the grant itself', () => {
        const admin = evidence(run(withSubscription({ app: [HERE] }, member('pg_create_subscription', { inherit: false, setOption: false, admin: true }))), 'R1-DB-APP-MEMBERSHIP');
        expect(admin).toBe(
          `${direct('inherit=false set=false admin=true', 'bizcaiaos_app neither inherits its privileges nor can SET ROLE to it through this grant, but with ADMIN, bizcaiaos_app can grant this role to itself or other roles with any INHERIT and SET options, which opens both')}` +
            `${SUBSCRIBE}bizcaiaos_app holds CREATE on ${HERE}; ${NONE_FOUND}`,
        );
      });

      it('leaves the evidence of every other forbidden membership unchanged', () => {
        for (const predefined of ['pg_read_all_data', 'pg_write_all_data', 'pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program']) {
          expect(evidence(run(withSubscription({ app: [HERE], acting: [{ role: APP, database: HERE }] }, member(predefined))), 'R1-DB-APP-MEMBERSHIP')).toBe(
            `bizcaiaos_app is a member of ${predefined} via ${predefined} (inherit=true set=true admin=false): privileged predefined role; bizcaiaos_app inherits this role's privileges and can SET ROLE to it`,
          );
        }
      });
    });

    it('fails on membership in a SUPERUSER or BYPASSRLS role, and in another owner of BizcaiaOS objects', () => {
      const attributes = run(withMemberships(member('ops_admin', { superuser: true }), member('service_role', { bypassRls: true })));
      expect(evidence(attributes, 'R1-DB-APP-MEMBERSHIP')).toMatch(/member of ops_admin[^\n]*SUPERUSER[\s\S]*member of service_role[^\n]*BYPASSRLS/);
      const owned = supabaseSnapshot();
      owned.functions[0].owner = 'legacy_owner';
      owned.memberships = [member('legacy_owner')];
      const checks = run(owned);
      expect(failed(checks)).toEqual(['R1-DB-APP-MEMBERSHIP', 'R1-DB-OWNER']);
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toContain('member of legacy_owner via legacy_owner (inherit=true set=true admin=false): owns BizcaiaOS objects in public');
    });

    it('passes a harmless unrelated membership and records it', () => {
      const checks = run(withMemberships(member('reporting_readers', { inherit: false, setOption: false })));
      expect(failed(checks)).toEqual([]);
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toContain('bizcaiaos_app memberships, none across the boundary: reporting_readers');
    });

    it('treats the connection owner as the migration owner on a local database, and reports a missing application role', () => {
      const local = { ...supabaseSnapshot(), identity: { ...supabaseSnapshot().identity, user: 'local_owner' } };
      for (const rel of local.relations) rel.owner = 'local_owner';
      for (const fn of local.functions) fn.owner = 'local_owner';
      local.memberships = [member('local_owner', { inherit: false })];
      expect(evidence(run(local, 'local'), 'R1-DB-APP-MEMBERSHIP')).toContain('member of local_owner via local_owner (inherit=false set=true admin=false): the migration owner');
      const missing = { ...supabaseSnapshot(), roles: [role(OWNER)] };
      expect(evidence(run(missing), 'R1-DB-APP-MEMBERSHIP')).toBe('bizcaiaos_app does not exist');
    });

    it('prints n/a for options on servers without INHERIT/SET per membership', () => {
      const checks = run(withMemberships(member(OWNER, { inherit: null, setOption: null })));
      expect(evidence(checks, 'R1-DB-APP-MEMBERSHIP')).toContain(
        '(inherit=n/a set=n/a admin=false): the migration owner; INHERIT and SET are not recorded per membership before PostgreSQL 16, where any member can SET ROLE to the role',
      );
    });
  });

  it('fails when RLS is disabled on an expected table', () => {
    const snapshot = supabaseSnapshot();
    snapshot.relations = snapshot.relations.map((rel) => (rel.name === 'documents' ? { ...rel, rls: false } : rel));
    const checks = run(snapshot);
    expect(failed(checks)).toEqual(['R1-DB-RLS']);
    expect(evidence(checks, 'R1-DB-RLS')).toContain('RLS disabled on: documents');
  });

  it('fails when an expected policy is missing or an unexpected one appears', () => {
    const missing = supabaseSnapshot();
    missing.policies = missing.policies.filter((policy) => policy.table !== 'documents');
    expect(evidence(run(missing), 'R1-DB-RLS')).toContain('expected policy missing: documents.documents_select_visible');
    const extra = supabaseSnapshot();
    extra.policies.push({ table: 'documents', name: 'anon_read_all', functions: [] });
    expect(failed(run(extra))).toEqual(['R1-DB-RLS']);
    expect(evidence(run(extra), 'R1-DB-RLS')).toContain('unexpected policy: documents.anon_read_all');
  });

  it('fails when anon or authenticated regain access', () => {
    const snapshot = supabaseSnapshot();
    snapshot.relationPrivileges.anon.properties = ['SELECT'];
    snapshot.functionExecute.authenticated['current_app_user_id()'] = true;
    expect(failed(run(snapshot))).toEqual(['R1-DB-ANON', 'R1-DB-AUTHENTICATED']);
  });

  it('fails when future functions would be executable by PUBLIC, and on wider trusted-function grants', () => {
    const future = supabaseSnapshot();
    future.defaultAcls = future.defaultAcls.filter((acl) => acl.schema !== '(all schemas)');
    expect(failed(run(future))).toEqual(['R1-DB-FUTURE-FUNCTIONS']);
    const trusted = supabaseSnapshot();
    trusted.trustedGrants.push({ function: 'bootstrap_organization', grantee: 'authenticated' });
    expect(failed(run(trusted))).toEqual(['R1-DB-TRUSTED-FUNCTIONS']);
  });

  it('fails on migration history drift, including a missing Migration 019', () => {
    const without019 = supabaseSnapshot();
    without019.migrations = MIGRATION_FILES.slice(0, -1);
    expect(failed(run(without019))).toEqual(['R1-DB-MIGRATIONS']);
    expect(evidence(run(without019), 'R1-DB-MIGRATIONS')).toContain('not applied: 019_revoke_public_function_execute.sql');
    const none = supabaseSnapshot();
    none.migrations = null;
    expect(failed(run(none))).toEqual(['R1-DB-MIGRATIONS']);
  });

  it('reports the application-role connection as the wrong verification access, without guessing', () => {
    const snapshot = supabaseSnapshot();
    snapshot.identity = { ...snapshot.identity, user: APP };
    snapshot.migrations = 'unreadable';
    const checks = run(snapshot, 'staging');
    expect(statusOf(checks)).toMatchObject({ 'R1-DB-IDENTITY': 'FAIL', 'R1-DB-MIGRATIONS': 'NOT_VERIFIED' });
    expect(checks.find((item) => item.id === 'R1-DB-IDENTITY')!.remediation).toBe('verification-access');
    expect(statusOf(run(snapshot, 'local'))).toMatchObject({ 'R1-DB-OWNER': 'NOT_VERIFIED', 'R1-DB-FUTURE-FUNCTIONS': 'NOT_VERIFIED' });
  });

  it('never passes vacuously when no BizcaiaOS function exists', () => {
    const snapshot = supabaseSnapshot();
    snapshot.functions = [];
    expect(failed(run(snapshot))).toEqual(expect.arrayContaining(['R1-DB-PUBLIC', 'R1-DB-APP-PRIVILEGES']));
  });
});

describe('R1 read-only enforcement', () => {
  const FORBIDDEN = /\b(insert|update|delete|merge|create|alter|drop|grant|revoke|truncate|copy|vacuum|analyze|reindex|cluster|comment|security|lock|call|do|execute|set|reset|refresh|listen|notify|prepare|declare)\b/i;

  it('allowlists only SELECT statements over catalogs and privilege functions', () => {
    for (const [name, sql] of Object.entries(QUERIES)) {
      expect(sql.trim(), name).toMatch(/^(select|with)\s/i);
      // Privilege names such as 'UPDATE' are string literals, not statements.
      expect(sql.replace(/'[^']*'/g, "''"), name).not.toMatch(FORBIDDEN);
      expect(sql, name).not.toContain(';');
    }
    expect(Object.isFrozen(QUERIES)).toBe(true);
    expect(TRANSACTION.begin).toBe('begin transaction isolation level repeatable read read only');
    expect(TRANSACTION.end).toBe('rollback');
  });

  it('sends only the read-only transaction and allowlisted queries, then rolls back', async () => {
    const sent: string[] = [];
    const responses: Record<string, unknown[]> = {
      [QUERIES.identity]: [{ database: 'd', user: OWNER, version: 'PostgreSQL 17', publicSchema: true, readOnly: true }],
      [QUERIES.roles]: [role(APP)],
      [QUERIES.migrationsAccess]: [{ tracked: true, readable: true }],
      [QUERIES.migrations]: [],
      [QUERIES.schemaPrivileges]: [{ usage: true, canCreate: false }],
    };
    const client = { query: async (sql: string) => { sent.push(sql); return { rows: responses[sql] ?? [] }; } };
    await collectSnapshot(client, APP);
    const allowed = new Set<string>([...Object.values(QUERIES), TRANSACTION.begin, TRANSACTION.end]);
    expect(sent[0]).toBe(TRANSACTION.begin);
    expect(sent.at(-1)).toBe(TRANSACTION.end);
    expect(sent.filter((sql) => !allowed.has(sql))).toEqual([]);
  });

  it('stops before reading anything else when the database does not confirm READ ONLY, and still rolls back', async () => {
    const sent: string[] = [];
    const client = {
      query: async (sql: string) => {
        sent.push(sql);
        return { rows: sql === QUERIES.identity ? [{ readOnly: false }] : [] };
      },
    };
    await expect(collectSnapshot(client, APP)).rejects.toThrow(/did not confirm a read-only transaction/);
    expect(sent).toEqual([TRANSACTION.begin, QUERIES.identity, TRANSACTION.end]);
  });

  it('refuses any statement outside the allowlist', async () => {
    const sent: string[] = [];
    const client = { query: async (sql: string) => { sent.push(sql); return { rows: [{ readOnly: true }] }; } };
    await expect(withReadOnlySession(client, (query) => query('drop table x' as never))).rejects.toThrow(/refuses SQL outside its read-only allowlist/);
    expect(sent).not.toContain('drop table x');
    expect(sent.at(-1)).toBe(TRANSACTION.end);
  });
});
