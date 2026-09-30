import './loadEnv.js';
import pg from 'pg';
import { applicationRoleName, quoteIdent, quoteLiteral, requiredEnv } from './migrate.js';

const { Client } = pg;

/**
 * Local/bootstrap only: creates the application role when it does not exist.
 * An existing role is never altered (no password or attribute change); its
 * attributes are only checked. Production application roles are created and
 * managed by the database operator, not by this command.
 */
export async function provisionApplicationRole(): Promise<{ created: boolean; roleName: string }> {
  const purpose = 'provision the application role';
  const migrateUrl = requiredEnv('DATABASE_MIGRATE_URL', purpose);
  const roleName = applicationRoleName();

  const client = new Client({ connectionString: migrateUrl });
  await client.connect();
  try {
    const existing = await client.query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = $1',
      [roleName],
    );
    const role = existing.rows[0];
    if (role) {
      if (!role.rolcanlogin || role.rolsuper || role.rolbypassrls) {
        throw new Error(
          `application role ${roleName} exists but must be LOGIN, NOSUPERUSER and NOBYPASSRLS; ` +
            'it was not changed',
        );
      }
      console.log(`application role ${roleName} already exists; not modified`);
      return { created: false, roleName };
    }

    const password = requiredEnv('POSTGRES_APP_PASSWORD', purpose);
    await client.query(
      `create role ${quoteIdent(roleName)} login nosuperuser nocreatedb nocreaterole nobypassrls ` +
        `password ${quoteLiteral(password)}`,
    );
    console.log(`created application role ${roleName}`);
    return { created: true, roleName };
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1]?.replaceAll('\\', '/').endsWith('/provisionAppRole.ts');
if (invokedDirectly) {
  provisionApplicationRole().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
