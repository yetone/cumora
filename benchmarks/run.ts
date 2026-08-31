#!/usr/bin/env tsx
/**
 * Benchmark runner — `tsx run.ts [chain|counting|werewolf|kanban|--all]`.
 *
 * Outputs:
 *   - One line of human-readable status per trial to stdout.
 *   - A structured JSON result file per scenario at
 *     `./results/<scenarioId>-<timestamp>.json`, suitable for trend
 *     dashboards or CI artifact upload.
 *   - Final exit code: 0 if ALL run scenarios pass; 1 otherwise.
 *
 * Environment: see ./lib/harness.ts for the required env vars.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScenario } from './lib/harness.ts'
import type { Scenario, BenchmarkResult } from './lib/types.ts'
import { chainScenario } from './games/chain.ts'
import { countingScenario } from './games/counting.ts'
import { werewolfScenario } from './games/werewolf.ts'
import { kanbanScenario } from './games/kanban.ts'

const REGISTRY: Record<string, Scenario> = {
  chain: chainScenario,
  counting: countingScenario,
  werewolf: werewolfScenario,
  kanban: kanbanScenario,
}

function usage(): never {
  console.error(`usage: tsx run.ts <scenarioId> [scenarioId...] | --all\n`)
  console.error(`available scenarios:`)
  for (const [id, s] of Object.entries(REGISTRY)) {
    console.error(`  ${id.padEnd(10)}  ${s.description}`)
  }
  process.exit(2)
}

function parseArgs(argv: string[]): string[] {
  if (argv.length === 0) usage()
  if (argv.includes('--all')) return Object.keys(REGISTRY)
  const unknown = argv.filter((a) => !REGISTRY[a])
  if (unknown.length > 0) {
    console.error(`unknown scenarios: ${unknown.join(', ')}`)
    usage()
  }
  return argv
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const resultsDir = resolve(here, 'results')
  mkdirSync(resultsDir, { recursive: true })

  const ids = parseArgs(process.argv.slice(2))
  const allResults: BenchmarkResult[] = []
  let allPassed = true

  for (const id of ids) {
    const scenario = REGISTRY[id]!
    console.log(`\n=== ${id}: ${scenario.description} ===`)
    console.log(`   ${scenario.trials} trials × ${(scenario.timeoutMs / 60_000).toFixed(0)}min budget`)

    const result = await runScenario(scenario)
    allResults.push(result)

    const fname = `${id}-${result.ranAt.replace(/[:.]/g, '-')}.json`
    const fpath = join(resultsDir, fname)
    writeFileSync(fpath, JSON.stringify(result, null, 2))
    console.log(`   → ${fpath}`)

    const verdictSym = result.verdict.pass ? '✅ PASS' : '❌ FAIL'
    const scoreStr = result.verdict.score !== undefined ? ` (score=${(result.verdict.score * 100).toFixed(0)}%)` : ''
    const reasonStr = result.verdict.reason ? ` — ${result.verdict.reason}` : ''
    console.log(`   ${verdictSym}${scoreStr}${reasonStr}`)

    if (!result.verdict.pass) allPassed = false
  }

  // Summary line — CI scrapes this.
  console.log(`\n=== summary ===`)
  for (const r of allResults) {
    const sym = r.verdict.pass ? '✅' : '❌'
    const score = r.verdict.score !== undefined ? ` ${(r.verdict.score * 100).toFixed(0)}%` : ''
    console.log(`${sym} ${r.scenarioId.padEnd(10)}${score}  trials=${r.trials.length}`)
  }
  console.log(`\nverdict: ${allPassed ? 'ALL PASS' : 'FAIL'}`)
  process.exit(allPassed ? 0 : 1)
}

main().catch((err) => {
  console.error('bench: fatal —', err instanceof Error ? err.message : err)
  process.exit(1)
})
