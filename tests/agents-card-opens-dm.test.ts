/**
 * Tapping an agent in the Agents list has to open a chat with it — on both
 * surfaces, including when this member has no DM row yet.
 *
 * The server seeds an agent's 1:1 only for whoever hired it
 * ("Auto-create a 1:1 direct conversation between the creator and the new
 * agent", server/src/api/router.ts). Everyone else has no row for any agent
 * added after they joined, so the lookup finds nothing. Desktop handles that
 * with an `api.openDirect` fallback; mobile's card had the same lookup with no
 * else branch, so for those members the tap did nothing at all — no
 * navigation, no error — while the identical tap on desktop worked.
 *
 * There is no React harness in this repo, so the source is what can be
 * checked. The invariant is parity: whichever surface is edited next, both
 * must still create the conversation rather than give up when it is absent.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const SURFACES = [
  { name: 'desktop', file: '../src/desktop/AgentsView.tsx' },
  { name: 'mobile', file: '../src/mobile/MobileAgents.tsx' },
] as const

/** The body from the "is there already a direct with this agent" lookup to the
 *  end of the handler that owns it. */
function tapHandler(source: string): string {
  const lookup = source.indexOf("c.kind === 'direct'")
  assert.notEqual(lookup, -1, 'the existing-direct lookup moved; this guard needs updating')
  return source.slice(lookup, lookup + 1200)
}

describe('agents list opens a DM', () => {
  for (const { name, file } of SURFACES) {
    it(`${name} creates the conversation when none exists yet`, async () => {
      const source = await readFile(new URL(file, import.meta.url), 'utf8')
      assert.match(
        tapHandler(source), /api\.openDirect\(/,
        `${name}: tapping an agent with no existing DM row falls through to nothing — `
        + 'every member except the one who hired that agent gets a dead tap',
      )
    })
  }
})
