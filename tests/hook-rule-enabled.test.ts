/**
 * `useHookAtTopLevel` is the only automated guard against a conditional hook,
 * and it has to stay on.
 *
 * The project has been bitten by this class three times. Twice it was caught by
 * hand and left a comment behind (`ChatPane.tsx`, `EmailComposer.tsx`, both
 * describing the same hoist); the third — a `useMemo` below three early returns
 * in the memoized `MessageRow` — survived in `main` because every call site
 * happened to pre-guard the branch that would have changed the hook count.
 * Nothing caught any of them, because `biome.json` had the rule set to `"off"`,
 * so a fully green `npm run lint` proved nothing about hook ordering.
 *
 * Turning it back off is a one-word edit that leaves lint green, which is
 * exactly why the switch itself needs a test rather than just the code it
 * protects. A conditional hook is not a style issue: React throws "Rendered
 * more hooks than during the previous render" and the nearest error boundary
 * eats the whole message list.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const BIOME_CONFIG = fileURLToPath(new URL('../biome.json', import.meta.url))

interface BiomeConfig {
  linter?: { rules?: { correctness?: Record<string, unknown> } }
}

async function readBiomeConfig(): Promise<BiomeConfig> {
  return JSON.parse(await readFile(BIOME_CONFIG, 'utf8')) as BiomeConfig
}

describe('biome.json', () => {
  it('keeps useHookAtTopLevel enabled', async () => {
    const config = await readBiomeConfig()
    const level = config.linter?.rules?.correctness?.useHookAtTopLevel
    assert.notEqual(
      level,
      'off',
      'useHookAtTopLevel must stay enabled — it is the only check that a hook is not called after an early return',
    )
    // `undefined` would inherit from the recommended preset, which does NOT
    // include this rule, so an omitted key is the same silent hole as "off".
    assert.ok(
      level === 'error' || level === 'warn' || (typeof level === 'object' && level !== null),
      `useHookAtTopLevel must be set explicitly in biome.json, got ${JSON.stringify(level)}`,
    )
  })
})
