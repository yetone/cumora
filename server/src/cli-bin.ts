/**
 * Cumora CLI binary entry point.
 *
 * Invoked via the `cumora` shell command (see ./bin/cumora) or directly:
 *   npx tsx server/src/cli-bin.ts <args...>
 */

async function main() {
  const argv = process.argv.slice(2)

  // BYOA Computer daemon: a long-running, standalone process that runs on the
  // user's own machine and talks to the server only over HTTP. Dispatch it
  // BEFORE importing runCli / the DB + Redis clients so it never loads them
  // (the daemon host has no DB/Redis access).
  if (argv[0] === 'agent' && argv[1] === 'computer') {
    try {
      const { runComputerDaemon } = await import('./agents/computer/daemon.js')
      await runComputerDaemon(argv.slice(2))
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 2
    }
    return
  }

  const { runCli } = await import('./agents/cli.js')
  const { writeCliSideEffectsToResultPath } = await import('./agents/cli-result.js')
  const { pool } = await import('./db/pool.js')
  const { redis, sub } = await import('./redis.js')

  const shutdown = async (code: number): Promise<never> => {
    try { await pool.end() } catch { /* ignore */ }
    try { redis.disconnect() } catch { /* ignore */ }
    try { sub.disconnect() } catch { /* ignore */ }
    process.exit(code)
  }

  try {
    const result = await runCli(argv)
    await writeCliSideEffectsToResultPath(result)
    process.stdout.write(result.text + '\n')
    await shutdown(result.exitCode)
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    await shutdown(2)
  }
}

main()
