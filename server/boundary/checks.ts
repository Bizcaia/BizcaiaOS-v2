/**
 * Shared result model for the R1 read-only boundary verifier.
 *
 * VERIFIED          R1 observed the evidence and the boundary holds, within the
 *                   check's scope (a repository check verifies the repository,
 *                   never the deployed infrastructure).
 * FAIL              R1 observed the evidence and the boundary does not hold.
 * NOT_VERIFIED      the evidence was not available (no configuration file, no
 *                   database connection, a provider setting R1 cannot observe,
 *                   or a catalog the connection may not read). Never a pass.
 * NOT_APPLICABLE    the subject does not exist here (e.g. no Supabase roles on
 *                   plain PostgreSQL).
 * INFO              recorded evidence only; neither verified nor failed.
 */
export type Status = 'VERIFIED' | 'FAIL' | 'NOT_VERIFIED' | 'NOT_APPLICABLE' | 'INFO';

/** Who has to act on a FAIL or NOT_VERIFIED, by kind of fix. */
export type Remediation =
  | 'repository'
  | 'configuration'
  | 'database-roles'
  | 'database-privileges'
  | 'migration'
  | 'rls'
  | 'provider-settings'
  | 'verification-access';

export type Check = {
  id: string;
  status: Status;
  /** What was checked. */
  title: string;
  /** Observations; variable names and non-secret identifiers only, never values. */
  evidence: string[];
  remediation?: Remediation;
  /** With --strict, a NOT_VERIFIED required check counts as a failure. */
  required: boolean;
};

export const NOT_VERIFIED_DATABASE = 'NOT_VERIFIED — DATABASE_CONNECTION_REQUIRED';
export const NOT_VERIFIED_CONFIGURATION = 'NOT_VERIFIED — CONFIGURATION_FILE_REQUIRED';

export function check(
  id: string,
  title: string,
  status: Status,
  evidence: string[],
  remediation: Remediation,
  required = true,
): Check {
  return {
    id,
    title,
    status,
    evidence,
    ...(status === 'FAIL' || status === 'NOT_VERIFIED' ? { remediation } : {}),
    required,
  };
}
