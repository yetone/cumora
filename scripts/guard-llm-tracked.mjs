#!/usr/bin/env node
/**
 * guard-llm-tracked — keeps the universal `llm_calls` ledger HONEST.
 *
 *   Every outbound sub2api call from server-side code MUST go through
 *   `getTrackedLlmClient()` (which auto-records to llm_calls), OR through a
 *   manual `recordLlmCall()` for the rare streaming case. Calling
 *   `getLlmClient()` directly without one of those is now a P1 incident: the
 *   spend that call generates won't show up in the per-purpose ledger, and the
 *   "which business burned the mini" rollup quietly drifts wrong.
 *
 * This script scans the server source for direct `getLlmClient()` references
 * and FAILS (exit 1) on any that aren't in the explicit allowlist below. Wire
 * into CI / the PR template / a pre-push hook.
 *
 * Allowlist policy: a file is allowed when EITHER
 *   (a) it's the ledger itself / the underlying client factory, OR
 *   (b) it does streaming AND records manually via recordLlmCall(). Add a
 *       comment explaining why above the import.
 *
 * Adding a NEW callsite that bypasses tracking should be a conscious,
 * reviewed act — same shape as scripts/guard-big-brain.mjs.
 *
 * Run:  node scripts/guard-llm-tracked.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SCAN_DIRS = ['server/src']
const SKIP = /(__tests__|__integration__|\.test\.ts$|\.d\.ts$|scripts\/)/

// Files where a direct `getLlmClient()` is allowed:
//   - llm.ts           — the factory itself
//   - llm-ledger.ts    — wraps the factory in getTrackedLlmClient (the ONE
//                        place outside llm.ts that imports it)
//   - turn.ts          — main agent turn is streaming; records per hop via
//                        recordLlmCall (purpose='agent-turn'). The non-
//                        streaming verify/compaction/steer-summary callsites
//                        in this file also record manually.
const ALLOW = new Set([
  'server/src/llm.ts',
  'server/src/agents/llm-ledger.ts',
  'server/src/agents/turn.ts',
])

const ROOT_LEN = ROOT.length + 1
function* walk(dir) {
  const abs = join(ROOT, dir)
  for (const entry of readdirSync(abs)) {
    const p = join(abs, entry)
    const rel = p.slice(ROOT_LEN).replaceAll('\\', '/')
    if (SKIP.test(rel)) continue
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(rel)
    else if (st.isFile() && p.endsWith('.ts')) yield rel
  }
}

const violations = []
for (const dir of SCAN_DIRS) {
  for (const rel of walk(dir)) {
    if (ALLOW.has(rel)) continue
    const text = readFileSync(join(ROOT, rel), 'utf8')
    // Match either:
    //   import { getLlmClient } from '../llm.js'
    //   const { getLlmClient } = await import('../llm.js')
    //   getLlmClient(...)
    // We use plain substring matches so the script has no regex dependencies
    // and is easy to read.
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      // Skip comments (line starts with // after trimming) and string literals
      // for the import path — the goal is to catch the ACTUAL call, not
      // mentions in docs.
      const t = line.trimStart()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      if (line.includes('getLlmClient(')) {
        violations.push({ file: rel, line: i + 1, snippet: line.trim() })
      }
    })
  }
}

if (violations.length === 0) {
  console.log('[guard-llm-tracked] OK — every sub2api callsite is tracked.')
  process.exit(0)
}

console.error('\n[guard-llm-tracked] FAIL — found getLlmClient() calls OUTSIDE the allowlist:\n')
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`)
  console.error(`    ${v.snippet}`)
}
console.error(`\n${violations.length} violation(s).\n`)
console.error('Every sub2api callsite must use getTrackedLlmClient() from')
console.error("server/src/agents/llm-ledger.ts so the spend is attributed to a")
console.error('purpose in llm_calls. For a streaming callsite that records via')
console.error('recordLlmCall() manually, add the file to the ALLOW set in this')
console.error('script (with a comment naming the purpose it records under).\n')
process.exit(1)
