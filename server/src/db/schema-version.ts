import type { QueryResult } from 'pg'
import { pool } from './pool.js'
import {
  type AppliedMigration,
  MigrationHistoryError,
  validateMigrationHistory,
} from './migrations/manifest.js'

export interface SchemaVersionQueryable {
  query<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>
}

/**
 * Read-only application-startup gate. This function deliberately contains no
 * CREATE/ALTER/DROP path: deployment owns migrations, while replicas only
 * confirm that the database is inside this build's supported version range.
 */
export async function verifySchemaCompatibility(
  queryable: SchemaVersionQueryable = pool,
): Promise<number> {
  let rows: AppliedMigration[]
  try {
    const result = await queryable.query<AppliedMigration>(
      `SELECT version, name, checksum, applied_at
         FROM schema_migrations
        ORDER BY version ASC`,
    )
    rows = result.rows
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === '42P01') {
      throw new MigrationHistoryError(
        'schema_uninitialized',
        'schema_migrations is missing; run `npm run migrate` before starting the server',
      )
    }
    throw err
  }

  return validateMigrationHistory(rows).currentVersion
}

/** Retry only transient database transport failures around the read-only
 * startup probe. Migration, checksum, and supported-range errors fail fast. */
export async function verifySchemaWithBootRetry(opts: {
  verifyFn?: () => Promise<number>
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
} = {}): Promise<number> {
  const verifyFn = opts.verifyFn ?? verifySchemaCompatibility
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const maxAttempts = opts.maxAttempts ?? 9
  let delayMs = 1_000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const version = await verifyFn()
      if (attempt > 1) {
        console.log(`[boot] schema verification recovered on attempt ${attempt}/${maxAttempts}`)
      }
      return version
    } catch (err) {
      if (err instanceof MigrationHistoryError) throw err
      const message = err instanceof Error ? err.message : String(err)
      const transient = /timeout|terminated|ECONNREFUSED|ECONNRESET|EOF/i.test(message)
      if (!transient || attempt === maxAttempts) throw err
      console.warn(
        `[boot] schema verification attempt ${attempt}/${maxAttempts} transient failure: ${message} — retrying in ${delayMs}ms`,
      )
      await sleep(delayMs)
      delayMs = Math.min(delayMs * 2, 30_000)
    }
  }

  throw new Error('schema verification retry loop exhausted')
}
