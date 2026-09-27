/**
 * The invite page must not hammer the accept endpoint when it is refused.
 *
 * The auto-accept effect's only re-POST guard was `joinedCompany`, which is set
 * on success. On a refusal the catch sets `acceptErr`, the `finally` puts `busy`
 * back to false, `preview.status` is still 'valid' and `joinedCompany` is still
 * null — which is precisely the condition to run again. So a refused accept
 * re-fired forever.
 *
 * The refusals are real and tested server behaviour: the free plan's human-seat
 * and agent caps answer 403 here, and `loadInvitation` does not pre-check them.
 * So the first invite past the cap POSTed in a loop while the invitee saw only
 * "Joining…" — the error text was already rendered in the component, but the
 * immediate re-fire flipped `busy` back on before it could be read.
 *
 * There is no React harness in this repo, so this models the effect's guard set
 * as a pure predicate and drives it through both outcomes. The source check at
 * the end ties that model to the component.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

interface State {
  tokenStr: string | null
  previewStatus: string | null
  busy: boolean
  joinedCompany: unknown
  autoAcceptedFor: string | null
}

/** The effect's guard chain, as the component now writes it. */
function wouldAutoAccept(s: State): boolean {
  if (!s.tokenStr) return false
  if (s.previewStatus !== 'valid') return false
  if (s.busy) return false
  if (s.joinedCompany) return false
  if (s.autoAcceptedFor === s.tokenStr) return false
  return true
}

const valid = (over: Partial<State> = {}): State => ({
  tokenStr: 'tok-1', previewStatus: 'valid', busy: false, joinedCompany: null,
  autoAcceptedFor: null, ...over,
})

describe('invite auto-accept', () => {
  it('fires once when the preview is valid', () => {
    assert.equal(wouldAutoAccept(valid()), true)
  })

  it('does not fire again after a refusal', () => {
    // The state the component is in after a 403: err shown, busy false,
    // preview still valid, nothing joined. This is the loop.
    const afterRefusal = valid({ autoAcceptedFor: 'tok-1' })
    assert.equal(
      wouldAutoAccept(afterRefusal), false,
      'a refused accept re-fires — the endpoint is hammered and the user only ever sees "Joining…"',
    )
  })

  it('does not fire again after success', () => {
    assert.equal(wouldAutoAccept(valid({ joinedCompany: { id: 'c1' }, autoAcceptedFor: 'tok-1' })), false)
  })

  it('still fires for a different invite', () => {
    // The guard is per token, not per mount: pasting a second invite link must
    // still auto-accept.
    assert.equal(wouldAutoAccept(valid({ tokenStr: 'tok-2', autoAcceptedFor: 'tok-1' })), true)
  })

  it('never fires while a request is in flight or the preview is not valid', () => {
    assert.equal(wouldAutoAccept(valid({ busy: true })), false)
    assert.equal(wouldAutoAccept(valid({ previewStatus: 'expired' })), false)
    assert.equal(wouldAutoAccept(valid({ tokenStr: null })), false)
  })

  it('the component guards on the attempt, not only on success', async () => {
    // The model above is only worth anything if the component matches it.
    const source = await readFile(new URL('../src/components/InviteAcceptScreen.tsx', import.meta.url), 'utf8')
    const effect = source.slice(source.indexOf('// Auto-accept the moment'))
    const body = effect.slice(0, effect.indexOf('}, [tokenStr'))

    assert.match(
      body, /autoAcceptedFor\.current === tokenStr/,
      'the auto-accept guards only on success again — any refusal will re-POST forever',
    )
    assert.match(body, /autoAcceptedFor\.current = tokenStr/, 'the attempt is never recorded, so the guard can never trip')
  })
})
