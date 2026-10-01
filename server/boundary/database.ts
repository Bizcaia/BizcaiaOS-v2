/**
 * R1 database checks: read-only catalog evidence for the D-PROD-13 boundary.
 *
 * Read-only by construction, not by convention:
 * 1. The only SQL R1 can send is the frozen QUERIES allowlist plus the
 *    transaction statements; `run()` refuses anything else.
 * 2. Everything runs inside BEGIN ... READ ONLY, which PostgreSQL enforces
 *    (writes fail with 25006), and the session aborts unless the database
 *    confirms transaction_read_only = on. The transaction is rolled back.
 * 3. Every query is a SELECT over catalogs and has_*_privilege functions.
 */
import pg from 'pg';
import { check, NOT_VERIFIED_DATABASE, type Check, type Status } from './checks.js';
import { MIGRATOR_ROLE } from './configuration.js';
import type { RlsModel } from './repository.js';

export type VerifyTarget = 'local' | 'staging' | 'production';

/** The trusted identity functions created by 003_organization_onboarding.sql. */
export const TRUSTED_FUNCTIONS = ['sync_authenticated_user', 'bootstrap_organization', 'accept_organization_invitation'];

const API_ROLES = ['anon', 'authenticated'] as const;
const OBSERVED_ROLES = ['anon', 'authenticated', 'service_role', 'postgres', 'supabase_admin'];
const APP_TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
/** Predefined roles that reach data or server files past every table grant and RLS policy. */
export const PRIVILEGED_PREDEFINED_ROLES = ['pg_read_all_data', 'pg_write_all_data', 'pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'];

export const QUERIES = Object.freeze({
  identity: `select current_database() as database, current_user as "user", version() as version,
    to_regnamespace('public') is not null as "publicSchema", current_setting('transaction_read_only') = 'on' as "readOnly"`,
  roles: `select r.rolname as name, r.rolcanlogin as login, r.rolsuper as superuser, r.rolbypassrls as "bypassRls",
      r.rolcreaterole as "createRole", r.rolcreatedb as "createDb"
    from pg_roles r where r.rolname = any($1::text[]) order by r.rolname`,
  // Every role the application role belongs to, directly or through other
  // roles, read from pg_auth_members: the relationship itself, whatever its
  // INHERIT and SET options (PostgreSQL 16+; null on older servers). Privilege
  // functions miss a NOINHERIT membership that still allows SET ROLE.
  memberships: `with recursive chain as (
      select m.roleid, array[m.roleid] as path, (to_jsonb(m) ->> 'inherit_option')::boolean as inherit,
        (to_jsonb(m) ->> 'set_option')::boolean as "setOption", m.admin_option as admin
      from pg_auth_members m where m.member = to_regrole($1)
      union all
      select m.roleid, c.path || m.roleid, (to_jsonb(m) ->> 'inherit_option')::boolean,
        (to_jsonb(m) ->> 'set_option')::boolean, m.admin_option
      from pg_auth_members m join chain c on m.member = c.roleid where not m.roleid = any(c.path))
    select r.rolname as role, array(select pg_get_userbyid(x)::text from unnest(c.path) x) as path, c.inherit, c."setOption",
      c.admin, r.rolsuper as superuser, r.rolbypassrls as "bypassRls"
    from chain c join pg_roles r on r.oid = c.roleid order by 1, 2`,
  migrationsAccess: `select to_regclass('public.schema_migrations') is not null as tracked,
    coalesce(has_table_privilege(current_user, to_regclass('public.schema_migrations')::oid, 'SELECT'), false) as readable`,
  migrations: `select id from public.schema_migrations order by id`,
  relations: `select c.relname as name, c.relkind::text as kind, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S') order by c.relname`,
  functions: `select p.oid::regprocedure::text as signature, p.proname as name, pg_get_userbyid(p.proowner) as owner,
      (select e.extname from pg_depend d join pg_extension e on e.oid = d.refobjid
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e' limit 1) as extension
    from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  relationPrivileges: `select c.relname as name, array_remove(array[
      case when c.relkind <> 'S' and has_table_privilege($1::text, c.oid, 'SELECT') then 'SELECT' end,
      case when c.relkind <> 'S' and has_table_privilege($1::text, c.oid, 'INSERT') then 'INSERT' end,
      case when c.relkind <> 'S' and has_table_privilege($1::text, c.oid, 'UPDATE') then 'UPDATE' end,
      case when c.relkind <> 'S' and has_table_privilege($1::text, c.oid, 'DELETE') then 'DELETE' end,
      case when c.relkind <> 'S' and has_table_privilege($1::text, c.oid, 'TRUNCATE') then 'TRUNCATE' end,
      case when c.relkind <> 'S' and has_table_privilege($1::text, c.oid, 'REFERENCES') then 'REFERENCES' end,
      case when c.relkind <> 'S' and has_table_privilege($1::text, c.oid, 'TRIGGER') then 'TRIGGER' end,
      case when c.relkind = 'S' and has_sequence_privilege($1::text, c.oid, 'USAGE') then 'USAGE' end,
      case when c.relkind = 'S' and has_sequence_privilege($1::text, c.oid, 'SELECT') then 'SELECT' end,
      case when c.relkind = 'S' and has_sequence_privilege($1::text, c.oid, 'UPDATE') then 'UPDATE' end], null) as privileges
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S') order by c.relname`,
  functionExecute: `select p.oid::regprocedure::text as signature, has_function_privilege($1::text, p.oid, 'EXECUTE') as can
    from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  schemaPrivileges: `select has_schema_privilege($1::text, 'public', 'USAGE') as usage, has_schema_privilege($1::text, 'public', 'CREATE') as "canCreate"`,
  extensions: `select e.extname as name, n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1`,
  policies: `select tablename as "table", policyname as name, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expression
    from pg_policies where schemaname = 'public' order by 1, 2`,
  defaultAcls: `select pg_get_userbyid(d.defaclrole) as role, coalesce(n.nspname, '(all schemas)') as schema,
      d.defaclobjtype::text as type, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
      a.privilege_type as privilege
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a order by 1, 2, 3, 4, 5`,
  trustedGrants: `select p.proname as "function", case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[]) and a.privilege_type = 'EXECUTE' order by 1, 2`,
});
export type QueryName = keyof typeof QUERIES;

/** Repeatable read gives one consistent catalog snapshot; READ ONLY is enforced by PostgreSQL. */
export const TRANSACTION = Object.freeze({ begin: 'begin transaction isolation level repeatable read read only', end: 'rollback' });

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** The only path from R1 to the database. */
export async function withReadOnlySession<T>(client: Queryable, operation: (run: (name: QueryName, params?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
  const run = async (name: QueryName, params?: unknown[]) => {
    if (!Object.prototype.hasOwnProperty.call(QUERIES, name)) throw new Error(`R1 refuses SQL outside its read-only allowlist: ${String(name)}`);
    return (await client.query(QUERIES[name], params)).rows;
  };
  await client.query(TRANSACTION.begin);
  try {
    const [identity] = await run('identity');
    if (identity?.readOnly !== true) throw new Error('the database did not confirm a read-only transaction; R1 stopped before reading anything else');
    return await operation(run);
  } finally {
    await client.query(TRANSACTION.end);
  }
}

export type Snapshot = {
  identity: { database: string; user: string; version: string; publicSchema: boolean; readOnly: boolean };
  appRole: string;
  roles: { name: string; login: boolean; superuser: boolean; bypassRls: boolean; createRole: boolean; createDb: boolean }[];
  /** Roles the application role is a member of; `path` runs from its direct membership to `role`. Options describe the last link. */
  memberships: { role: string; path: string[]; inherit: boolean | null; setOption: boolean | null; admin: boolean; superuser: boolean; bypassRls: boolean }[];
  /** null: no schema_migrations table; 'unreadable': the connection may not read it. */
  migrations: string[] | null | 'unreadable';
  relations: { name: string; kind: string; owner: string; rls: boolean }[];
  functions: { signature: string; name: string; owner: string; extension: string | null }[];
  relationPrivileges: Record<string, Record<string, string[]>>;
  functionExecute: Record<string, Record<string, boolean>>;
  schemaPrivileges: Record<string, { usage: boolean; canCreate: boolean }>;
  extensions: { name: string; schema: string }[];
  policies: { table: string; name: string; functions: string[] }[];
  defaultAcls: { role: string; schema: string; type: string; grantee: string; privilege: string }[];
  trustedGrants: { function: string; grantee: string }[];
};

export async function collectSnapshot(client: Queryable, appRole: string): Promise<Snapshot> {
  return withReadOnlySession(client, async (run) => {
    const [identity] = await run('identity');
    const roles = await run('roles', [[...new Set([appRole, MIGRATOR_ROLE, ...OBSERVED_ROLES])]]);
    const present = new Set(roles.map((role: { name: string }) => role.name));
    const memberships = await run('memberships', [appRole]);
    const [access] = await run('migrationsAccess');
    const migrations = !access.tracked ? null : !access.readable ? 'unreadable' : (await run('migrations')).map((row: { id: string }) => row.id);
    const relations = await run('relations');
    const functions = await run('functions');
    const subjects = ['public', ...[appRole, ...OBSERVED_ROLES].filter((role) => present.has(role))];
    const relationPrivileges: Snapshot['relationPrivileges'] = {};
    const functionExecute: Snapshot['functionExecute'] = {};
    const schemaPrivileges: Snapshot['schemaPrivileges'] = {};
    for (const subject of subjects) {
      relationPrivileges[subject] = Object.fromEntries((await run('relationPrivileges', [subject])).map((row) => [row.name, row.privileges]));
      functionExecute[subject] = Object.fromEntries((await run('functionExecute', [subject])).map((row) => [row.signature, row.can]));
      [schemaPrivileges[subject]] = await run('schemaPrivileges', [subject]);
    }
    const helpers = new Set(functions.filter((fn: { extension: string | null }) => !fn.extension).map((fn: { name: string }) => fn.name));
    const policies = (await run('policies')).map((row: { table: string; name: string; expression: string }) => ({
      table: row.table,
      name: row.name,
      functions: [...new Set([...row.expression.matchAll(/([a-z_][a-z0-9_]*)\s*\(/g)].map((match) => match[1]))].filter((name) => helpers.has(name)),
    }));
    return {
      identity,
      appRole,
      roles,
      memberships,
      migrations,
      relations,
      functions,
      relationPrivileges,
      functionExecute,
      schemaPrivileges,
      extensions: await run('extensions'),
      policies,
      defaultAcls: await run('defaultAcls'),
      trustedGrants: await run('trustedGrants', [TRUSTED_FUNCTIONS]),
    };
  });
}

export const DATABASE_CHECKS = {
  'R1-DB-IDENTITY': 'Verification connection: read-only transaction and the role it connects as',
  'R1-DB-ROLES': 'Role attributes: bizcaiaos_app and bizcaiaos_migrator (no SUPERUSER, CREATEROLE, CREATEDB, BYPASSRLS)',
  'R1-DB-APP-MEMBERSHIP': 'Application role is not a member (any INHERIT/SET option, direct or nested) of the migration owner, an owner of BizcaiaOS objects, a SUPERUSER/BYPASSRLS role, or a privileged predefined role',
  'R1-DB-MIGRATIONS': 'Migration history equals the registered chain (001..019), applied once each',
  'R1-DB-OWNER': 'The migration owner owns every BizcaiaOS relation and function in public',
  'R1-DB-APP-PRIVILEGES': 'Application role keeps what the API needs (CRUD, sequences, every function, RLS helpers) and nothing on schema_migrations',
  'R1-DB-PUBLIC': 'PUBLIC executes no BizcaiaOS function and holds no relation privilege (Migration 019)',
  'R1-DB-ANON': 'anon holds nothing in public (Supabase Data API role)',
  'R1-DB-AUTHENTICATED': 'authenticated holds nothing in public (Supabase Data API role)',
  'R1-DB-FUTURE-FUNCTIONS': 'Future functions: no PUBLIC EXECUTE by default; the application role gets EXECUTE (from pg_default_acl)',
  'R1-DB-TRUSTED-FUNCTIONS': 'Trusted identity functions are executable only by their owner and the application role',
  'R1-DB-RLS': 'Every table and policy the migrations define is present with RLS enabled; nothing unexpected',
  'R1-DB-DEFAULT-ACLS': 'Default privilege inventory (recorded only)',
  'R1-DB-SERVICE-ROLE': 'service_role (recorded only; outside D-PROD-13)',
  'R1-DB-EXTENSIONS': 'Extensions and extension-owned functions (recorded only)',
} as const;
type DatabaseCheckId = keyof typeof DATABASE_CHECKS;
const RECORD_ONLY: DatabaseCheckId[] = ['R1-DB-DEFAULT-ACLS', 'R1-DB-SERVICE-ROLE', 'R1-DB-EXTENSIONS'];

export function databaseNotConnected(): Check[] {
  return (Object.keys(DATABASE_CHECKS) as DatabaseCheckId[]).map((id) =>
    check(id, DATABASE_CHECKS[id], 'NOT_VERIFIED', [`${NOT_VERIFIED_DATABASE} (pass --database)`], 'verification-access', !RECORD_ONLY.includes(id)));
}

export function evaluate(snapshot: Snapshot, options: { target: VerifyTarget; registered: readonly string[]; rls: RlsModel }): Check[] {
  const checks: Check[] = [];
  const add = (id: DatabaseCheckId, status: Status, evidence: string[], remediation: Parameters<typeof check>[4]) =>
    checks.push(check(id, DATABASE_CHECKS[id], status, evidence, remediation, !RECORD_ONLY.includes(id)));
  const roleNames = new Set(snapshot.roles.map((role) => role.name));
  const user = snapshot.identity.user;
  const app = snapshot.appRole;
  const deployed = options.target !== 'local';
  const connectedAsApp = user === app;
  /** Staging/production: always the dedicated migrator. Locally: whoever ran the migrations (the connection). */
  const owner = deployed ? MIGRATOR_ROLE : connectedAsApp ? null : user;
  const bizFunctions = snapshot.functions.filter((fn) => !fn.extension);
  const tables = snapshot.relations.filter((rel) => ['r', 'p'].includes(rel.kind));
  const appTables = tables.filter((rel) => rel.name !== 'schema_migrations');
  const sequences = snapshot.relations.filter((rel) => rel.kind === 'S');

  // R1-DB-IDENTITY
  const identityProblems: string[] = [];
  if (!snapshot.identity.readOnly) identityProblems.push('transaction is not read-only');
  if (!snapshot.identity.publicSchema) identityProblems.push('schema public does not exist');
  if (connectedAsApp) identityProblems.push(`connected as the application role ${app}: use the migration/operator connection for verification`);
  else if (deployed && user !== MIGRATOR_ROLE) identityProblems.push(`connected as ${user}: ${options.target} verification must connect as ${MIGRATOR_ROLE}`);
  add('R1-DB-IDENTITY', identityProblems.length ? 'FAIL' : 'VERIFIED', [
    `database=${snapshot.identity.database} user=${user} server=${snapshot.identity.version.split(' on ')[0]}`,
    `transaction read only=${snapshot.identity.readOnly}`,
    ...identityProblems,
  ], 'verification-access');

  // R1-DB-ROLES
  const roleProblems: string[] = [];
  const roleEvidence: string[] = [];
  const attributes = (name: string, allowCreateDb: boolean) => {
    const role = snapshot.roles.find((entry) => entry.name === name);
    if (!role) return null;
    const problems = [
      !role.login && 'cannot log in',
      role.superuser && 'SUPERUSER',
      role.createRole && 'CREATEROLE',
      !allowCreateDb && role.createDb && 'CREATEDB',
      role.bypassRls && 'BYPASSRLS',
    ].filter(Boolean) as string[];
    roleEvidence.push(`${name}: login=${role.login} superuser=${role.superuser} createrole=${role.createRole} createdb=${role.createDb} bypassrls=${role.bypassRls}`);
    for (const problem of problems) roleProblems.push(`${name}: ${problem}`);
    return role;
  };
  if (!attributes(app, false)) roleProblems.push(`${app}: role does not exist`);
  const appOwns = [...snapshot.relations, ...bizFunctions].filter((item) => item.owner === app).length;
  if (appOwns) roleProblems.push(`${app}: owns ${appOwns} object(s) in public`);
  if (!attributes(MIGRATOR_ROLE, false)) {
    if (deployed) roleProblems.push(`${MIGRATOR_ROLE}: role does not exist`);
    else roleEvidence.push(`${MIGRATOR_ROLE}: not present (local database; migrations ran as ${user})`);
  }
  add('R1-DB-ROLES', roleProblems.length ? 'FAIL' : 'VERIFIED', [...roleProblems, ...roleEvidence], 'database-roles');

  // R1-DB-APP-MEMBERSHIP: the membership itself, not the privileges it happens
  // to pass on. A NOINHERIT membership adds no effective privilege, yet with
  // SET it still lets the application role SET ROLE to the owner.
  if (!roleNames.has(app)) {
    add('R1-DB-APP-MEMBERSHIP', 'FAIL', [`${app} does not exist`], 'database-roles');
  } else {
    const objectOwners = new Set([...snapshot.relations, ...bizFunctions].map((item) => item.owner).filter((name) => name !== app));
    const option = (value: boolean | null) => (value === null ? 'n/a' : String(value));
    const describe = (membership: Snapshot['memberships'][number]) =>
      `${app} is a member of ${membership.role} via ${membership.path.join(' -> ')} (inherit=${option(membership.inherit)} set=${option(membership.setOption)} admin=${membership.admin})`;
    const forbidden = snapshot.memberships.flatMap((membership) => {
      const reasons = [
        (membership.role === MIGRATOR_ROLE || membership.role === owner) && 'the migration owner',
        membership.role !== MIGRATOR_ROLE && membership.role !== owner && objectOwners.has(membership.role) && 'owns BizcaiaOS objects in public',
        membership.superuser && 'SUPERUSER',
        membership.bypassRls && 'BYPASSRLS',
        PRIVILEGED_PREDEFINED_ROLES.includes(membership.role) && 'privileged predefined role',
      ].filter(Boolean);
      return reasons.length ? [`${describe(membership)}: ${reasons.join(', ')}; a member can use its privileges or SET ROLE to it, past RLS and table grants`] : [];
    });
    add('R1-DB-APP-MEMBERSHIP', forbidden.length ? 'FAIL' : 'VERIFIED', forbidden.length ? forbidden : [
      snapshot.memberships.length
        ? `${app} memberships, none across the boundary: ${snapshot.memberships.map((membership) => membership.path.join(' -> ')).join('; ')}`
        : `${app} is a member of no role`,
      'read from pg_auth_members, whatever the INHERIT and SET options',
    ], 'database-roles');
  }

  // R1-DB-MIGRATIONS
  if (snapshot.migrations === 'unreadable') {
    add('R1-DB-MIGRATIONS', 'NOT_VERIFIED', [`${user} may not read public.schema_migrations; R1 does not elevate privileges`], 'verification-access');
  } else if (snapshot.migrations === null) {
    add('R1-DB-MIGRATIONS', 'FAIL', ['public.schema_migrations does not exist: no migration has run'], 'migration');
  } else {
    const recorded = snapshot.migrations;
    const exact = recorded.length === options.registered.length && recorded.every((id, index) => id === options.registered[index]);
    const missing = options.registered.filter((id) => !recorded.includes(id));
    const unknown = recorded.filter((id) => !options.registered.includes(id));
    add('R1-DB-MIGRATIONS', exact ? 'VERIFIED' : 'FAIL', [
      `recorded=${recorded.length} registered=${options.registered.length} latest=${recorded.at(-1) ?? '(none)'}`,
      ...missing.map((id) => `not applied: ${id}`),
      ...unknown.map((id) => `recorded but not registered: ${id}`),
    ], 'migration');
  }

  // R1-DB-OWNER
  if (!owner) {
    add('R1-DB-OWNER', 'NOT_VERIFIED', ['connected as the application role: the expected owner is unknown'], 'verification-access');
  } else {
    const foreign = [
      ...snapshot.relations.filter((rel) => rel.owner !== owner).map((rel) => `${rel.name} (${rel.owner})`),
      ...bizFunctions.filter((fn) => fn.owner !== owner).map((fn) => `${fn.signature} (${fn.owner})`),
    ];
    add('R1-DB-OWNER', foreign.length ? 'FAIL' : 'VERIFIED', [
      `expected owner=${owner}; relations=${snapshot.relations.length}; BizcaiaOS functions=${bizFunctions.length}`,
      ...foreign.slice(0, 20).map((item) => `not owned: ${item}`),
    ], 'database-privileges');
  }

  // R1-DB-APP-PRIVILEGES
  if (!roleNames.has(app)) {
    add('R1-DB-APP-PRIVILEGES', 'FAIL', [`${app} does not exist`], 'database-roles');
  } else {
    const problems: string[] = [];
    if (!snapshot.schemaPrivileges[app]?.usage) problems.push('lacks USAGE on schema public');
    if (snapshot.schemaPrivileges[app]?.canCreate) problems.push('has CREATE on schema public');
    const tableGaps = appTables.filter((rel) => APP_TABLE_PRIVILEGES.some((privilege) => !(snapshot.relationPrivileges[app]?.[rel.name] ?? []).includes(privilege)));
    if (tableGaps.length) problems.push(`missing SELECT/INSERT/UPDATE/DELETE on: ${tableGaps.map((rel) => rel.name).join(', ')}`);
    const sequenceGaps = sequences.filter((rel) => !(snapshot.relationPrivileges[app]?.[rel.name] ?? []).includes('USAGE'));
    if (sequenceGaps.length) problems.push(`missing USAGE on sequences: ${sequenceGaps.map((rel) => rel.name).join(', ')}`);
    if ((snapshot.relationPrivileges[app]?.schema_migrations ?? []).length) problems.push('has privileges on schema_migrations');
    const notExecutable = bizFunctions.filter((fn) => !snapshot.functionExecute[app]?.[fn.signature]);
    if (notExecutable.length) problems.push(`cannot execute: ${notExecutable.map((fn) => fn.signature).join(', ')}`);
    const helpers = new Set(snapshot.policies.flatMap((policy) => policy.functions));
    if (!bizFunctions.length) problems.push('no BizcaiaOS functions found: the check would be vacuous');
    add('R1-DB-APP-PRIVILEGES', problems.length ? 'FAIL' : 'VERIFIED', problems.length ? problems.map((problem) => `${app} ${problem}`) : [
      `${app}: CRUD on ${appTables.length} tables, USAGE on ${sequences.length} sequences, executes all ${bizFunctions.length} BizcaiaOS functions incl. ${helpers.size} RLS helpers; no schema_migrations access`,
    ], 'database-privileges');
  }

  // R1-DB-PUBLIC
  const publicExecutable = bizFunctions.filter((fn) => snapshot.functionExecute.public?.[fn.signature]);
  const publicRelations = snapshot.relations.filter((rel) => (snapshot.relationPrivileges.public?.[rel.name] ?? []).length);
  add('R1-DB-PUBLIC', !bizFunctions.length || publicExecutable.length || publicRelations.length ? 'FAIL' : 'VERIFIED', !bizFunctions.length
    ? ['no BizcaiaOS functions found in public: the check would be vacuous']
    : [
        `BizcaiaOS functions executable by PUBLIC: ${publicExecutable.length} of ${bizFunctions.length}; relations with PUBLIC privileges: ${publicRelations.length}`,
        ...publicExecutable.slice(0, 20).map((fn) => `PUBLIC can execute: ${fn.signature}`),
        ...publicRelations.map((rel) => `PUBLIC has privileges on: ${rel.name}`),
      ], 'database-privileges');

  // R1-DB-ANON / R1-DB-AUTHENTICATED
  for (const role of API_ROLES) {
    const id = role === 'anon' ? 'R1-DB-ANON' : 'R1-DB-AUTHENTICATED';
    if (!roleNames.has(role)) {
      add(id, 'NOT_APPLICABLE', ['role not present (not a Supabase database)'], 'database-privileges');
      continue;
    }
    const relationsHeld = snapshot.relations.filter((rel) => (snapshot.relationPrivileges[role]?.[rel.name] ?? []).length);
    const functionsHeld = bizFunctions.filter((fn) => snapshot.functionExecute[role]?.[fn.signature]);
    const ownerDefaults = owner ? snapshot.defaultAcls.filter((acl) => acl.role === owner && acl.grantee === role) : [];
    const providerDefaults = snapshot.defaultAcls.filter((acl) => acl.role !== owner && acl.grantee === role && acl.schema === 'public');
    add(id, relationsHeld.length || functionsHeld.length || ownerDefaults.length ? 'FAIL' : 'VERIFIED', [
      `relations with privileges: ${relationsHeld.length}; BizcaiaOS functions executable: ${functionsHeld.length}; default privileges from the migration owner: ${ownerDefaults.length}`,
      ...relationsHeld.slice(0, 20).map((rel) => `holds ${snapshot.relationPrivileges[role][rel.name].join(',')} on ${rel.name}`),
      ...functionsHeld.slice(0, 20).map((fn) => `can execute ${fn.signature}`),
      ...[...new Set(providerDefaults.map((acl) => `${acl.role} ${acl.type}`))].map((entry) => `provider default in public (applies only to objects that role creates): ${entry}`),
    ], 'database-privileges');
  }

  // R1-DB-FUTURE-FUNCTIONS
  if (!owner) {
    add('R1-DB-FUTURE-FUNCTIONS', 'NOT_VERIFIED', ['connected as the application role: the migration owner is unknown'], 'verification-access');
  } else {
    const globalDefaults = snapshot.defaultAcls.filter((acl) => acl.role === owner && acl.schema === '(all schemas)' && acl.type === 'f');
    const publicFuture = !globalDefaults.length || globalDefaults.some((acl) => acl.grantee === 'PUBLIC');
    const appFuture = snapshot.defaultAcls.some((acl) => acl.role === owner && acl.schema === 'public' && acl.type === 'f' && acl.grantee === app && acl.privilege === 'EXECUTE');
    add('R1-DB-FUTURE-FUNCTIONS', publicFuture || !appFuture ? 'FAIL' : 'VERIFIED', [
      globalDefaults.length
        ? `global function default for ${owner}: ${publicFuture ? 'PUBLIC still executes' : 'no PUBLIC EXECUTE'}`
        : `no global function default for ${owner}: PostgreSQL's built-in PUBLIC EXECUTE applies`,
      `${app} receives EXECUTE on new functions in public: ${appFuture}`,
      'read from pg_default_acl; no function is created',
    ], 'database-privileges');
  }

  // R1-DB-TRUSTED-FUNCTIONS
  const grantees = new Map<string, Set<string>>();
  for (const grant of snapshot.trustedGrants) {
    if (!grantees.has(grant.function)) grantees.set(grant.function, new Set());
    grantees.get(grant.function)!.add(grant.grantee);
  }
  const trustedProblems: string[] = [];
  for (const name of TRUSTED_FUNCTIONS) {
    const set = grantees.get(name);
    if (!set) {
      trustedProblems.push(`${name}: not found`);
      continue;
    }
    const owners = new Set(bizFunctions.filter((fn) => fn.name === name).map((fn) => fn.owner));
    const unexpected = [...set].filter((grantee) => !owners.has(grantee) && grantee !== app);
    if (unexpected.length) trustedProblems.push(`${name}: also executable by ${unexpected.join(', ')}`);
    if (!set.has(app)) trustedProblems.push(`${name}: ${app} cannot execute`);
  }
  add('R1-DB-TRUSTED-FUNCTIONS', trustedProblems.length ? 'FAIL' : 'VERIFIED',
    trustedProblems.length ? trustedProblems : [`${TRUSTED_FUNCTIONS.join(', ')}: executable only by their owner and ${app}`], 'database-privileges');

  // R1-DB-RLS (expected state derived from the repository's migrations)
  const rlsProblems: string[] = [];
  const byName = new Map(tables.map((rel) => [rel.name, rel]));
  for (const table of options.rls.tables) {
    const rel = byName.get(table);
    if (!rel) rlsProblems.push(`expected table missing: ${table}`);
    else if (!rel.rls) rlsProblems.push(`RLS disabled on: ${table}`);
  }
  for (const rel of appTables) {
    if (!options.rls.tables.has(rel.name)) rlsProblems.push(`table not in the migration model: ${rel.name}${rel.rls ? '' : ' (no RLS)'}`);
  }
  const actual = new Set(snapshot.policies.map((policy) => `${policy.table}.${policy.name}`));
  for (const key of options.rls.policies) if (!actual.has(key)) rlsProblems.push(`expected policy missing: ${key}`);
  for (const key of actual) if (!options.rls.policies.has(key)) rlsProblems.push(`unexpected policy: ${key}`);
  add('R1-DB-RLS', rlsProblems.length ? 'FAIL' : 'VERIFIED', [
    `expected ${options.rls.tables.size} tables with RLS and ${options.rls.policies.size} policies; found ${appTables.filter((rel) => rel.rls).length} with RLS and ${snapshot.policies.length} policies`,
    ...rlsProblems.slice(0, 30),
  ], 'rls');

  // Recorded only.
  add('R1-DB-DEFAULT-ACLS', 'INFO', [...new Set(snapshot.defaultAcls.map((acl) => `${acl.role} ${acl.schema} ${acl.type}`))].map((key) => {
    const entries = snapshot.defaultAcls.filter((acl) => `${acl.role} ${acl.schema} ${acl.type}` === key);
    return `${key}: ${[...new Set(entries.map((acl) => `${acl.grantee}=${acl.privilege}`))].join(' ')}`;
  }), 'database-privileges');
  if (!roleNames.has('service_role')) {
    add('R1-DB-SERVICE-ROLE', 'NOT_APPLICABLE', ['role not present (not a Supabase database)'], 'database-privileges');
  } else {
    add('R1-DB-SERVICE-ROLE', 'INFO', [
      `relations with privileges: ${Object.values(snapshot.relationPrivileges.service_role ?? {}).filter((held) => held.length).length}; BizcaiaOS functions executable: ${bizFunctions.filter((fn) => snapshot.functionExecute.service_role?.[fn.signature]).length}`,
      'recorded only: Migration 019 does not reference service_role',
    ], 'database-privileges');
  }
  add('R1-DB-EXTENSIONS', 'INFO', [
    ...snapshot.extensions.map((extension) => `${extension.name} in schema ${extension.schema}`),
    `extension-owned functions in public: ${snapshot.functions.length - bizFunctions.length}`,
  ], 'database-privileges');

  return checks;
}

/** Connects, collects one read-only snapshot, disconnects. Never logs the URL. */
export async function databaseChecks(url: string, options: { target: VerifyTarget; appRole: string; registered: readonly string[]; rls: RlsModel }) {
  const client = new pg.Client({ connectionString: url, statement_timeout: 30_000, application_name: 'bizcaiaos-r1-verify-boundary' });
  await client.connect();
  try {
    return evaluate(await collectSnapshot(client, options.appRole), options);
  } finally {
    await client.end();
  }
}
