/**
 * Nothing the user half-typed may follow them into another conversation.
 *
 * ChatPane's composer has three overlays: the mention picker, the emoji picker
 * and the poll composer. The scope-change effect reset the first two and not
 * the third, and the third is the one that can do damage: `PollComposer` keeps
 * question/options in its own state and reads `conversationId` from its props
 * at submit time. So a half-filled poll that survived the switch posted the old
 * room's question into the new room — and notified everyone there.
 *
 * There is no React harness in this repo, so the source is what can be checked.
 * The invariant is that every overlay is reset together: the next one added has
 * to join them, and the poll composer is additionally keyed by conversation so
 * its draft cannot straddle a switch even if another entry point forgets.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const CHAT_PANE = new URL('../src/desktop/ChatPane.tsx', import.meta.url)

/** The body of the effect that runs when the composer's scope changes. */
async function scopeEffect(): Promise<string> {
  const source = await readFile(CHAT_PANE, 'utf8')
  const start = source.indexOf('lastSyncedScopeRef.current = scopeKey')
  assert.notEqual(start, -1, 'the scope-change effect moved; this guard needs updating')
  return source.slice(start, start + 1200)
}

describe('composer overlays do not survive a conversation switch', () => {
  for (const [overlay, reset] of [
    ['mention picker', 'setMention(null)'],
    ['emoji picker', 'setEmojiOpen(false)'],
    ['poll composer', 'setPollComposerOpen(false)'],
  ] as const) {
    it(`the ${overlay} is reset`, async () => {
      assert.ok(
        (await scopeEffect()).includes(reset),
        `${overlay}: a draft left open in one conversation carries into the next one`,
      )
    })
  }

  it('the poll composer is keyed by conversation', async () => {
    // Without a key React reconciles the same element across the switch, so the
    // internal question/options stay while conversationId flips underneath them.
    const source = await readFile(CHAT_PANE, 'utf8')
    const render = source.slice(source.indexOf('<PollComposer'))
    assert.match(
      render.slice(0, 400), /key=\{convoId\}/,
      'PollComposer is unkeyed — its draft can straddle a conversation switch and post to the wrong room',
    )
  })
})
