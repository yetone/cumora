#!/usr/bin/env node
/**
 * guard-engine-registry — an engine is either wired up everywhere, or nowhere.
 *
 * Making a BYOA engine runnable means adding its id to about ten hand-kept
 * lists across the server, the renderer and the tooling. Miss one and nothing
 * shouts: the worst of them, `BYOA_SOURCES`, is read through
 * `normalizeByoaSource()`, which falls back to `'byoa-claude'` for anything it
 * does not recognise — so an engine missing from that list does not error, it
 * quietly bills every one of its runs to Claude in the ledger.
 *
 * That failure mode is not hypothetical. #102 was one of two identical blocks
 * getting a fix while the other did not, and `cli-version.ts` spent a while
 * telling the next person to sync a list that had been deleted. This script
 * makes the sync mechanical instead of remembered.
 *
 * The check is anchored on `ENGINE_IDS` in agents/computer/engine.ts — the
 * engines the daemon actually probes and wakes. For each id it asserts:
 *
 *   1. an ADAPTERS entry                        engine.ts
 *   2. the EngineId union carries it            engine.ts, computer/registry.ts, src/types.ts
 *   3. a label and a PATH binary                src/lib/engines.ts
 *   4. RUNNABLE_ENGINE_IDS carries it           src/lib/engines.ts
 *   5. a version spec                           computer/cli-version.ts
 *   6. `byoa-<id>` in the shared source list    runtime/byoa-source.ts
 *   7. `byoa-<id>` in every ledger union        llm-ledger, observability, admin/api, api/client
 *   8. the engine's binary is spawn-guarded     scripts/guard-big-brain.mjs
 *
 * A guard that quietly stops checking is worse than no guard, so every anchor
 * below is REQUIRED: if a refactor moves or renames one, this fails with
 * "anchor not found" rather than passing vacuously.
 *
 * Run:  node scripts/guard-engine-registry.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** Pull one declaration's text out of a file, or explain why we could not.
 *  `anchor` is matched as a RegExp with one capture group holding the body. */
export function extract(source, anchor) {
  const m = source.match(anchor)
  return m ? m[1] : null
}

/** The engines the daemon probes and wakes — everything else is derived. */
export function engineIds(engineTs) {
  const body = extract(engineTs, /export const ENGINE_IDS: EngineId\[\] = \[([^\]]*)\]/)
  if (body == null) return null
  return body.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

/** Every check, as data: where to look, what must be in it, and how to say so.
 *  `body` returns the slice of the file the id must appear in — narrowing to
 *  the declaration means an unrelated mention elsewhere cannot satisfy it. */
const CHECKS = [
  {
    file: 'server/src/agents/computer/engine.ts',
    what: 'the ADAPTERS registry',
    body: (s) => extract(s, /const ADAPTERS: Record<EngineId, EngineAdapter> = \{([\s\S]*?)\n\}/),
    needle: (id) => `${id}: new `,
    fix: 'add `<id>: new <Name>Adapter(),` to ADAPTERS',
  },
  {
    file: 'server/src/agents/computer/engine.ts',
    what: 'the EngineId union',
    body: (s) => extract(s, /export type EngineId = ([^\n]*)/),
    needle: (id) => `'${id}'`,
    fix: "widen `export type EngineId`",
  },
  {
    file: 'server/src/agents/computer/registry.ts',
    what: 'the EngineId union',
    body: (s) => extract(s, /export type EngineId = ([^\n]*)/),
    needle: (id) => `'${id}'`,
    fix: "widen `export type EngineId`",
  },
  {
    file: 'src/types.ts',
    what: 'the renderer EngineId union',
    body: (s) => extract(s, /export type EngineId = ([^\n]*)/),
    needle: (id) => `'${id}'`,
    fix: "widen `export type EngineId`",
  },
  {
    file: 'src/lib/engines.ts',
    what: 'ENGINE_LABEL',
    body: (s) => extract(s, /export const ENGINE_LABEL: Record<string, string> = \{([\s\S]*?)\n\}/),
    needle: (id) => `${id}:`,
    fix: 'add a display name to ENGINE_LABEL',
  },
  {
    file: 'src/lib/engines.ts',
    what: 'ENGINE_BIN',
    body: (s) => extract(s, /export const ENGINE_BIN: Record<string, string> = \{([\s\S]*?)\n\}/),
    needle: (id) => `${id}:`,
    fix: 'add the PATH binary name to ENGINE_BIN',
  },
  {
    file: 'src/lib/engines.ts',
    what: 'the runnable-engine list',
    // Two accepted shapes: the ordered `RUNNABLE_ENGINES` tuple the UI pickers
    // map over, and the older `RUNNABLE_ENGINE_IDS` Set literal it is derived
    // from. Reading whichever exists keeps this guard from being the thing
    // that blocks collapsing that duplicate.
    body: (s) => extract(s, /export const RUNNABLE_ENGINES(?::[^=]*)? = \[([^\]]*)\]/)
      ?? extract(s, /export const RUNNABLE_ENGINE_IDS(?::[^=]*)? = new Set(?:<string>)?\(\[([^\]]*)\]/),
    needle: (id) => `'${id}'`,
    fix: 'add the id to RUNNABLE_ENGINE_IDS, or the engine stays detect-only in the UI',
  },
  {
    file: 'server/src/agents/computer/cli-version.ts',
    what: 'ENGINE_VERSION_SPECS',
    body: (s) => extract(s, /export const ENGINE_VERSION_SPECS: Record<string, EngineVersionSpec> = \{([\s\S]*?)\n\}/),
    needle: (id) => `${id}: {`,
    fix: 'add a version spec, or the Computers tab cannot report the installed version',
  },
  {
    file: 'server/src/agents/runtime/byoa-source.ts',
    what: 'BYOA_SOURCES',
    body: (s) => extract(s, /export const BYOA_SOURCES = \[([\s\S]*?)\] as const/),
    needle: (id) => `'byoa-${id}'`,
    // The one that fails silently: normalizeByoaSource() maps anything unknown
    // to 'byoa-claude', so the runs are billed, just to the wrong engine.
    fix: "add 'byoa-<id>' — without it every run of this engine is attributed to Claude in the ledger",
  },
  {
    file: 'server/src/agents/llm-ledger.ts',
    what: 'LlmCallSource',
    body: (s) => extract(s, /export type LlmCallSource = ([^\n]*)/),
    needle: (id) => `'byoa-${id}'`,
    fix: "widen LlmCallSource with 'byoa-<id>'",
  },
  {
    file: 'server/src/agents/observability.ts',
    what: 'TriageSource',
    body: (s) => extract(s, /export type TriageSource = ([^\n]*)/),
    needle: (id) => `'byoa-${id}'`,
    fix: "widen TriageSource with 'byoa-<id>'",
  },
  {
    file: 'src/admin/api.ts',
    what: 'the admin LlmCallSource union',
    body: (s) => extract(s, /export type LlmCallSource = ([^\n]*)/),
    needle: (id) => `'byoa-${id}'`,
    fix: "widen LlmCallSource with 'byoa-<id>'",
  },
  {
    file: 'src/api/client.ts',
    what: 'ApiTriageSource',
    body: (s) => extract(s, /export type ApiTriageSource = ([^\n]*)/),
    needle: (id) => `'byoa-${id}'`,
    fix: "widen ApiTriageSource with 'byoa-<id>'",
  },
  {
    file: 'server/src/agents/computer/registry.ts',
    what: 'ENGINE_BINS',
    body: (s) => extract(s, /const ENGINE_BINS(?::[^=]*)? = \{([\s\S]*?)\n\}/),
    needle: (id) => `${id}:`,
    fix: 'add the binary mapping to ENGINE_BINS',
  },
  {
    file: 'server/src/agents/computer/registry.ts',
    what: 'listAgentsForComputer default model fallback',
    body: (s) => extract(s, /export async function listAgentsForComputer[\s\S]*?return rows\.map\(\(r\) => \{([\s\S]*?)\n\s{2}\}\)/),
    needle: (id) => `r.engine === '${id}'`,
    fix: "add a default model fallback for '<id>' in listAgentsForComputer",
  },
  {
    file: 'server/src/agents/computer/daemon.ts',
    what: 'authFailureHint',
    body: (s) => extract(s, /export function authFailureHint[\s\S]*?\{([\s\S]*?)\n\}/),
    needle: (id) => `engine === '${id}'`,
    fix: "add an auth failure hint for '<id>' in authFailureHint",
  },
  {
    file: 'server/src/agents/computer/daemon.ts',
    what: 'triageModel',
    body: (s) => extract(s, /private triageModel\(\): string \{([\s\S]*?)\n\s{2}\}/),
    needle: (id) => `this.adapter.id === '${id}'`,
    fix: "add triage model resolution for '<id>' in triageModel",
  },
]

/** The spawn guard keys on BINARY names, not engine ids (cursor's binary is
 *  `cursor-agent`), so it is checked against ENGINE_BIN rather than the id. */
function binForId(enginesTs, id) {
  const body = extract(enginesTs, /export const ENGINE_BIN: Record<string, string> = \{([\s\S]*?)\n\}/)
  if (body == null) return null
  const m = body.match(new RegExp(`\\b${id}:\\s*'([^']+)'`))
  return m ? m[1] : null
}

export function scanRepo() {
  const problems = []
  const engineTs = read('server/src/agents/computer/engine.ts')
  const ids = engineIds(engineTs)
  if (!ids || ids.length === 0) {
    return [{ where: 'server/src/agents/computer/engine.ts', why: 'anchor not found: ENGINE_IDS — update this guard alongside the refactor' }]
  }

  const cache = new Map()
  const fileOf = (rel) => {
    if (!cache.has(rel)) cache.set(rel, read(rel))
    return cache.get(rel)
  }

  for (const check of CHECKS) {
    const body = check.body(fileOf(check.file))
    if (body == null) {
      problems.push({ where: check.file, why: `anchor not found: ${check.what} — update this guard alongside the refactor` })
      continue
    }
    for (const id of ids) {
      if (!body.includes(check.needle(id))) {
        problems.push({ where: `${check.file} → ${check.what}`, why: `'${id}' is missing — ${check.fix.replace('<id>', id)}` })
      }
    }
  }

  // The big-brain guard's R4 rule refuses a direct spawn of any supported
  // engine binary. A new engine left out of it can be spawned outside the
  // adapter, which is exactly the classify=small / run=big split it protects.
  // Anchored on the rule's own id rather than on its regex source: the rule
  // number is what the guard documents and is stable across rewrites of the
  // pattern itself.
  const bigBrain = read('scripts/guard-big-brain.mjs')
  const at = bigBrain.indexOf('R4 —')
  const r4 = at < 0 ? null : extract(bigBrain.slice(at, at + 400), /\(([a-z0-9|-]{10,})\)/)
  if (r4 == null) {
    problems.push({ where: 'scripts/guard-big-brain.mjs', why: 'anchor not found: the R4 engine-binary alternation — update this guard alongside the refactor' })
  } else {
    const guarded = new Set(r4.split('|'))
    const enginesTs = fileOf('src/lib/engines.ts')
    for (const id of ids) {
      const bin = binForId(enginesTs, id)
      if (!bin) continue // already reported as a missing ENGINE_BIN entry
      if (!guarded.has(bin)) {
        problems.push({
          where: 'scripts/guard-big-brain.mjs → R4',
          why: `'${bin}' is missing from the engine-binary alternation — a direct spawn of it would go unguarded`,
        })
      }
    }
  }

  return problems
}

// Compare filesystem paths, not a hand-built file:// URL. On Windows
// process.argv[1] is `E:\...` while import.meta.url is `file:///E:/...`, so
// the string form never matched and `npm run guard:engine-registry` exited 0
// without ever calling scanRepo() — the guard silently becoming a no-op is the
// exact failure this file exists to prevent. Same shape guard-big-brain.mjs
// already used.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const problems = scanRepo()
  if (problems.length === 0) {
    console.log('✅ engine registry guard: every engine in ENGINE_IDS is wired into all of its lists.')
    process.exit(0)
  }
  console.error('🚨 engine registry is half-wired:\n')
  for (const p of problems) console.error(`  ${p.where}\n    ${p.why}`)
  console.error('\nAn engine must be in every list or none — a partly-wired one fails quietly.')
  process.exit(1)
}
