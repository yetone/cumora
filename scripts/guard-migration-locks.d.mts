// Type declarations for the migration lock guard (scripts/guard-migration-locks.mjs).
export interface MigrationLockProblem {
  /** Repo-relative path of the offending migration. */
  where: string
  /** What it locks, and how to write it instead. */
  why: string
}
/** Strip block and line comments so prose about a pattern is not read as the pattern. */
export function stripComments(source: string): string
/** Lower-cased names of the tables a migration creates itself. */
export function tablesCreatedIn(sql: string): Set<string>
/** Every lock hazard in one migration's source text. */
export function scanMigration(file: string, source: string): MigrationLockProblem[]
/** Scan every migration except the grandfathered ones. */
export function scanRepo(): MigrationLockProblem[]
/** Applied migrations whose checksum-pinned SQL cannot be rewritten, and why. */
export function grandfathered(): Map<string, string>
