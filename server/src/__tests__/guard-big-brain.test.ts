import { test } from 'node:test'
import assert from 'node:assert/strict'
// The guard is plain ESM tooling; tsx lets this .ts test import the .mjs.
import { scanRepo, lineViolations } from '../../../scripts/guard-big-brain.mjs'

// The bottom line: the BIG model is ONLY for real, heavy tasks. This test is the
// CI enforcement of that — if anyone introduces an ungated big-brain selection,
// `npm test` goes red here (P0) before it can ship. See scripts/guard-big-brain.mjs.

test('the live source has ZERO ungated big-brain use', () => {
  const v = scanRepo()
  assert.deepEqual(
    v, [],
    `\n🚨 P0 — ungated big-brain use detected:\n` +
      v.map((x: { rel: string; ln: number; why: string }) => `  ${x.rel}:${x.ln} → ${x.why}`).join('\n') +
      `\nFix it (use the support model) or, for a genuine new real-task site, add the file to ALLOW in scripts/guard-big-brain.mjs.`,
  )
})

// --- The rules actually catch violations (so the guard above isn't a no-op) ---

test('R1 — a bare realTaskModel() (no enforceModelPolicy gate) is caught', () => {
  assert.ok(lineViolations('server/src/agents/turn.ts', `const m = realTaskModel(persona.model)`).length > 0)
})

test('R1 — realTaskModel() WRAPPED in enforceModelPolicy() is allowed', () => {
  assert.deepEqual(
    lineViolations('server/src/agents/turn.ts', `model: enforceModelPolicy(realTaskModel(persona.model), 'agent-turn'),`),
    [],
  )
})

test('R2 — selecting the big-model env directly is caught', () => {
  assert.ok(lineViolations('server/src/agents/tools.ts', `model: env.OPENAI_MODEL,`).length > 0)
})

test('R2 — the SUPPORT model env is allowed everywhere', () => {
  assert.deepEqual(lineViolations('server/src/agents/tools.ts', `model: env.OPENAI_MODEL_SUPPORT,`), [])
})

test('R2b — a hardcoded big-model name is caught', () => {
  assert.ok(lineViolations('server/src/agents/agenda.ts', `model: 'gpt-5.5-turbo',`).length > 0)
  assert.ok(lineViolations('server/src/agents/agenda.ts', `model: 'claude-opus-4-7',`).length > 0)
})

test('R3 — adapter.run() outside the daemon is caught; inside it is allowed', () => {
  assert.ok(lineViolations('server/src/agents/somewhere.ts', `await adapter.run({ model, input })`).length > 0)
  assert.deepEqual(lineViolations('server/src/agents/computer/daemon.ts', `await this.adapter.run({ model, input })`), [])
})

test('R4 — spawning a supported engine binary outside the engine adapter is caught', () => {
  for (const bin of ['claude', 'codex', 'grok', 'cursor-agent']) {
    assert.ok(lineViolations('server/src/agents/tools.ts', `spawn('${bin}', args)`).length > 0, bin)
  }
  assert.deepEqual(lineViolations('server/src/agents/computer/engine.ts', `spawn('cursor-agent', args)`), [])
})

test('commented-out examples do not trip the guard', () => {
  assert.deepEqual(lineViolations('server/src/agents/tools.ts', `// model: env.OPENAI_MODEL,`), [])
})
