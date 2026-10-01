/**
 * Canonical, ordered list of BizcaiaOS migrations (database/NNN_*.sql).
 *
 * Data only: no imports, no database connection, no .env loading, no
 * filesystem access, and no side effects. The migration runner
 * (server/migrate.ts) applies this list; read-only tools such as the R1
 * boundary verifier import it from here without loading the runner.
 */
export const MIGRATION_FILES = [
  '001_core_schema.sql',
  '002_rbac_rls.sql',
  '003_organization_onboarding.sql',
  '004_property_workflow_rls.sql',
  '005_projects_write_rls.sql',
  '006_negotiations_rls.sql',
  '007_documents.sql',
  '008_tasks.sql',
  '009_payments.sql',
  '010_agreement_signatures.sql',
  '011_interactions.sql',
  '012_property_lifecycle_history.sql',
  '013_property_stage_transitions.sql',
  '014_property_status_transitions.sql',
  '015_lifecycle_negotiation_exception.sql',
  '016_property_creation_rules.sql',
  '017_legacy_stage_remediation.sql',
  '018_lifecycle_optimistic_concurrency.sql',
  '019_revoke_public_function_execute.sql',
];
