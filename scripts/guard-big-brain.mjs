#!/usr/bin/env node
/**
 * guard-big-brain — P0 tripwire for Cumora's bottom line:
 *
 *   The BIG model (opus-class) may ONLY do real, heavy tasks. ANY other use of
 *   the big brain is a P0 incident.
 *
 * The big model is allowed to reach an LLM through EXACTLY two gated paths:
 *   1. cloud — enforceModelPolicy(realTaskModel(...), '<real-task purpose>')
 *      (the policy forces the support model for any non-real purpose)
 *   2. BYOA  — adapter.run(...) in the daemon, reached ONLY by a triage verdict
 *      that asked for the big brain (handler='big' / a genuine actionable item)
 *
 * Everything else MUST use the support/small model (OPENAI_MODEL_SUPPORT /
 * supportModel() / --model haiku|gpt-5.4-mini). This script scans the source for
 * any big-model selection or engine spawn that escapes those gates and FAILS
 * (exit 1) with a P0 report. Wire it into CI (it also runs as a test).
 *
 * If you legitimately add a NEW real-task big-brain site, that is a conscious,
 * reviewed act: add the file to the relevant ALLOW list below.
 *
 * Run:  node scripts/guard-big-brain.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SCAN_DIRS = ['server/src', 'agent-cli/src']
const SKIP = /(__tests__|\.test\.ts$|\.d\.ts$)/

// Files where a given big-brain signature is LEGITIMATELY allowed. Editing these
// lists is the explicit, reviewed gate for adding/moving a big-brain site.
const ALLOW = {
  // realTaskModel() + the OPENAI_MODEL (big) env live in the policy module.
  policy: ['server/src/agents/model-policy.ts'],
  // The BYOA big-brain engine spawn (adapter.run) lives ONLY in the daemon,
  // where it is gated by the local triage (handler='big').
  adapterRun: ['server/src/agents/computer/daemon.ts'],
  // The engine adapter is the ONLY place that spawns a supported engine binary
  // (and it splits classify=small vs run=big internally).
  engineSpawn: ['server/src/agents/computer/engine.ts'],
}

function walk(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') out.push(...walk(p)) }
    else if (p.endsWith('.ts') && !SKIP.test(p)) out.push(p)
  }
  return out
}

/** The detection rules for a single line of `rel`. Exported so it's unit-tested
 *  directly (the patterns are the contract). Returns an array of reasons. */
export function lineViolations(rel, raw) {
  const out = []
  // Drop line-comments so commented examples / docs don't trip the guard.
  const code = raw.replace(/\/\/.*$/, '')

  // R1 — realTaskModel() must be wrapped in enforceModelPolicy() right there.
  // A bare realTaskModel() is an ungated big-model selection.
  if (/\brealTaskModel\s*\(/.test(code) && !ALLOW.policy.includes(rel) &&
      !/enforceModelPolicy\s*\(\s*realTaskModel\s*\(/.test(code)) {
    out.push('realTaskModel() used WITHOUT the enforceModelPolicy(... , purpose) gate — raw big-model selection')
  }
  // R2 — the big-model env used AS a model in a call, outside the policy.
  if (/\bmodel\s*:\s*env\.OPENAI_MODEL\b/.test(code) && !/OPENAI_MODEL_/.test(code) && !ALLOW.policy.includes(rel)) {
    out.push('selects the BIG model env (OPENAI_MODEL) directly — must go through enforceModelPolicy or use OPENAI_MODEL_SUPPORT')
  }
  // R2b — a hardcoded big-model string used AS a model (bypasses the env+policy).
  if (/\bmodel\s*:\s*['"`](gpt-5\.5|gpt-5-codex|claude-opus|o1|o3|gpt-4)/i.test(code)) {
    out.push('hardcoded big-model name as a model selection — use realTaskModel()/enforceModelPolicy or the support model')
  }
  // R3 — adapter.run( (BYOA big brain) only in the gated daemon path.
  if (/\.run\s*\(\s*\{/.test(code) && /adapter\.run|this\.adapter\.run/.test(code) && !ALLOW.adapterRun.includes(rel)) {
    out.push('big-brain engine spawn (adapter.run) outside the gated daemon path')
  }
  // R4 — a supported engine binary spawned directly, outside the adapter.
  if (/(?:spawn|execFile\w*|exec)\s*\(\s*['"`](claude|codex|grok|cursor-agent|opencode|pi)['"`]/.test(code) && !ALLOW.engineSpawn.includes(rel)) {
    out.push('engine binary spawned outside the engine adapter (bypasses the classify=small / run=big split)')
  }
  return out
}

/** Scan the configured source dirs. Exported for the test. */
export function scanRepo() {
  const violations = []
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const rel = relative(ROOT, file).replaceAll('\\', '/')
      readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
        for (const why of lineViolations(rel, raw)) {
          violations.push({ rel, ln: i + 1, line: raw.trim().slice(0, 150), why })
        }
      })
    }
  }
  return violations
}

// Run the scan + report ONLY when invoked as a CLI; importing has no side effects.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const violations = scanRepo()
  if (violations.length > 0) {
    console.error('\n🚨🚨🚨  P0 — UNNECESSARY BIG-BRAIN USE DETECTED  🚨🚨🚨\n')
    console.error('Bottom line: the BIG model is ONLY for real, heavy tasks. These selections escape the gate:\n')
    for (const v of violations) {
      console.error(`  ✗ ${v.rel}:${v.ln}`)
      console.error(`      ${v.line}`)
      console.error(`      → ${v.why}\n`)
    }
    console.error('FIX one of:')
    console.error('  • non-real task  → use the SUPPORT model (OPENAI_MODEL_SUPPORT / supportModel() / --model haiku)')
    console.error('  • real cloud task → model: enforceModelPolicy(realTaskModel(persona.model), \'<real-task purpose>\')')
    console.error('  • legit NEW real-task big-brain site → add the file to ALLOW in scripts/guard-big-brain.mjs (reviewed)')
    console.error(`\n${violations.length} violation(s). This is a P0 — do not ship.\n`)
    process.exit(1)
  }
  console.log('✅ big-brain guard: every big-model use is gated (enforceModelPolicy / the daemon triage path). No unnecessary big-brain use.')
}
