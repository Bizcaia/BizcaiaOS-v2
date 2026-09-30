import { describe, expect, it } from 'vitest';
import { MIGRATION_FILES, migrationPrefixProblem } from './migrate.js';

describe('migrationPrefixProblem', () => {
  it('accepts an empty history, any prefix, and the full list', () => {
    expect(migrationPrefixProblem([], MIGRATION_FILES)).toBeNull();
    expect(migrationPrefixProblem(MIGRATION_FILES.slice(0, 11), MIGRATION_FILES)).toBeNull();
    expect(migrationPrefixProblem([...MIGRATION_FILES], MIGRATION_FILES)).toBeNull();
  });

  it('rejects a history with a gap', () => {
    const withGap = MIGRATION_FILES.slice(0, 11).filter((id) => id !== '005_projects_write_rls.sql');
    expect(migrationPrefixProblem(withGap, MIGRATION_FILES)).toMatch(/not a prefix.*005_projects_write_rls\.sql/);
  });

  it('rejects unregistered migration ids', () => {
    expect(migrationPrefixProblem(['001_core_schema.sql', '999_unknown.sql'], MIGRATION_FILES)).toMatch(
      /unregistered migrations: 999_unknown\.sql/,
    );
  });
});
