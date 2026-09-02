/**
 * Immutable database-migration ledger understood by this application build.
 *
 * Append new entries; never edit or reorder an applied entry. The checksum is
 * stored in PostgreSQL and compared on every migration run and application
 * startup, so changing historical SQL fails closed instead of silently
 * redefining what an old version meant.
 */
export interface MigrationMetadata {
  version: number
  name: string
  checksum: string
}

export interface AppliedMigration extends MigrationMetadata {
  applied_at?: Date | string
}

export const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: '0001_legacy_baseline',
    checksum: '5250b63e17bb5a028483b72a799b868418b875e7c0802be4168175b9930aa7d0',
  },
] as const satisfies readonly MigrationMetadata[]

/** This build intentionally supports one exact schema range. Expand/contract
 * releases may widen the range, but both bounds must remain explicit. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1
export const MAX_SUPPORTED_SCHEMA_VERSION = 1

function assertManifestShape(): void {
  for (let i = 0; i < SCHEMA_MIGRATIONS.length; i++) {
    const migration = SCHEMA_MIGRATIONS[i]
    if (migration.version !== i + 1) throw new Error('schema migration versions must be contiguous from 1')
    if (!/^\d{4}_[a-z0-9_]+$/.test(migration.name)) throw new Error(`invalid migration name: ${migration.name}`)
    if (!/^[a-f0-9]{64}$/.test(migration.checksum)) throw new Error(`invalid migration checksum: ${migration.name}`)
  }
  if (MAX_SUPPORTED_SCHEMA_VERSION !== SCHEMA_MIGRATIONS.at(-1)?.version) {
    throw new Error('maximum supported schema version must match the manifest tip')
  }
  if (MIN_SUPPORTED_SCHEMA_VERSION < 1 || MIN_SUPPORTED_SCHEMA_VERSION > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new Error('invalid supported schema version range')
  }
}

assertManifestShape()

export class MigrationHistoryError extends Error {
  readonly code: 'schema_uninitialized' | 'schema_behind' | 'schema_ahead' | 'migration_history_invalid'

  constructor(
    code: MigrationHistoryError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'MigrationHistoryError'
    this.code = code
  }
}

export interface MigrationHistoryState {
  currentVersion: number
  pending: readonly MigrationMetadata[]
}

/**
 * Validate that the persisted ledger is an exact, contiguous prefix of this
 * build's immutable manifest. Migrators may accept a pending suffix; normal
 * application startup requires the supported range to already be present.
 */
export function validateMigrationHistory(
  appliedRows: readonly AppliedMigration[],
  opts: { allowPending?: boolean } = {},
): MigrationHistoryState {
  const applied = [...appliedRows].sort((a, b) => a.version - b.version)

  if ((applied.at(-1)?.version ?? 0) > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new MigrationHistoryError(
      'schema_ahead',
      `database schema version ${applied.at(-1)?.version} is newer than this application supports (${MAX_SUPPORTED_SCHEMA_VERSION})`,
    )
  }

  if (applied.length > SCHEMA_MIGRATIONS.length) {
    throw new MigrationHistoryError(
      'schema_ahead',
      `database schema version ${applied.at(-1)?.version ?? 'unknown'} is newer than this application supports (${MAX_SUPPORTED_SCHEMA_VERSION})`,
    )
  }

  for (let i = 0; i < applied.length; i++) {
    const actual = applied[i]
    const expected = SCHEMA_MIGRATIONS[i]
    if (!expected || actual.version !== expected.version) {
      throw new MigrationHistoryError(
        'migration_history_invalid',
        `migration history is not a contiguous prefix at position ${i + 1}`,
      )
    }
    if (actual.name !== expected.name || actual.checksum !== expected.checksum) {
      throw new MigrationHistoryError(
        'migration_history_invalid',
        `migration ${actual.version} does not match immutable manifest metadata`,
      )
    }
  }

  const currentVersion = applied.at(-1)?.version ?? 0
  const pending = SCHEMA_MIGRATIONS.slice(applied.length)
  if (opts.allowPending) return { currentVersion, pending }

  if (currentVersion === 0) {
    throw new MigrationHistoryError(
      'schema_uninitialized',
      'database schema is uninitialized; run `npm run migrate` before starting the server',
    )
  }
  if (currentVersion < MIN_SUPPORTED_SCHEMA_VERSION) {
    throw new MigrationHistoryError(
      'schema_behind',
      `database schema version ${currentVersion} is behind the supported range ${MIN_SUPPORTED_SCHEMA_VERSION}-${MAX_SUPPORTED_SCHEMA_VERSION}; run ` +
        '`npm run migrate` before starting the server',
    )
  }
  if (currentVersion > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new MigrationHistoryError(
      'schema_ahead',
      `database schema version ${currentVersion} is newer than the supported range ${MIN_SUPPORTED_SCHEMA_VERSION}-${MAX_SUPPORTED_SCHEMA_VERSION}`,
    )
  }

  return { currentVersion, pending }
}
