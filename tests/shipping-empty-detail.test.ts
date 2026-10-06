/**
 * With nothing selected, the Shipping detail pane must offer "pick one", not
 * sit on the "Opening contract…" placeholder forever.
 *
 * The store starts with `selectedId` and `loadingFeatureId` both null, so a
 * bare `loadingFeatureId === selectedId` is true until the user clicks a
 * feature. A workspace with no features never gets that click, and the pane
 * stayed on the loading state. The loading branch has to require a selection.
 *
 * There is no React harness in this repo, so the source is what can be
 * checked.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'

it('the opening-contract placeholder needs a selected feature', async () => {
  const source = await readFile(new URL('../src/components/ShippingWorkspace.tsx', import.meta.url), 'utf8')
  const at = source.indexOf("t('ship.openingContract')")
  assert.notEqual(at, -1, 'the opening-contract placeholder moved; this guard needs updating')
  // The condition is the ternary test on the same line, before the placeholder.
  const condition = source.slice(source.lastIndexOf('\n', at) + 1, at)
  assert.match(condition, /loadingFeatureId === selectedId/, 'the loading condition changed shape; this guard needs updating')
  assert.match(condition, /\{\s*selectedId\b[^?]*&&\s*loadingFeatureId === selectedId/, 'with nothing selected, null === null shows "Opening contract…" forever')
})
