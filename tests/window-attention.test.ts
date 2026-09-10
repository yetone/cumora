/**
 * "Is the user actually looking?" — the question that decides both whether a
 * desktop toast fires and whether an arriving message is marked read.
 *
 * It used to be a private helper in NotificationToasts with no tests at all,
 * even though every notification in the product goes through it. The read path
 * asked a different and weaker question — "is this conversation selected?" — so
 * a window sitting behind a browser marked every arriving message read: no
 * badge, and `POST /conversations/:id/read` moved the server cursor to NOW(),
 * which no reload undoes. There is no unread divider in the thread to fall back
 * on, so the user came back to no sign at all that anything had happened.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { evaluateAttention, type AttentionEnv } from '../src/lib/windowAttention'
import { isWatchingConversation, type WatchInputs } from '../src/lib/watching'

function env(over: Partial<AttentionEnv> = {}): AttentionEnv {
  return { visibility: 'visible', electron: false, nativeFocused: true, hasFocus: true, ...over }
}

describe('evaluateAttention', () => {
  it('a hidden window is never attentive, whatever else claims otherwise', () => {
    // Minimized, on another desktop, or a background browser tab. Electron can
    // still report native focus here, and hasFocus() can still say true.
    assert.equal(evaluateAttention(env({ visibility: 'hidden' })), false)
    assert.equal(evaluateAttention(env({ visibility: 'hidden', electron: true, nativeFocused: true })), false)
    assert.equal(evaluateAttention(env({ visibility: 'hidden', hasFocus: true })), false)
  })

  it('a visible Electron window behind another app is not attentive', () => {
    // The everyday case: cumora is on screen, the user is in their browser.
    // visibilityState is 'visible' and nothing is throttled — only native focus
    // knows the user is elsewhere.
    assert.equal(evaluateAttention(env({ electron: true, nativeFocused: false })), false)
  })

  it('in Electron the main process wins over a stale hasFocus', () => {
    // document.hasFocus() can return a stale true on macOS. Believing it would
    // suppress the toast and clear the badge for a window the user cannot see.
    assert.equal(evaluateAttention(env({ electron: true, nativeFocused: false, hasFocus: true })), false)
    assert.equal(evaluateAttention(env({ electron: true, nativeFocused: true, hasFocus: false })), true)
  })

  it('on the web an unfocused window is not attentive', () => {
    assert.equal(evaluateAttention(env({ electron: false, hasFocus: false })), false)
  })

  it('assumes the user is present when there is nothing to ask', () => {
    // No hasFocus() to consult: the alternative is a badge that never clears.
    assert.equal(evaluateAttention(env({ hasFocus: undefined })), true)
    assert.equal(evaluateAttention(env({ visibility: undefined, hasFocus: undefined })), true)
  })

  it('a focused, visible window is attentive on both platforms', () => {
    assert.equal(evaluateAttention(env()), true)
    assert.equal(evaluateAttention(env({ electron: true })), true)
  })
})

describe('isWatchingConversation', () => {
  function w(over: Partial<WatchInputs> = {}): WatchInputs {
    return {
      conversationId: 'g-1',
      selectedConversationId: 'g-1',
      view: 'conversations',
      mobileStack: 'chat',
      attentive: true,
      ...over,
    }
  }

  it('the ordinary case: selected, on screen, app in front', () => {
    assert.equal(isWatchingConversation(w()), true)
  })

  it('a message for another conversation is never being watched', () => {
    assert.equal(isWatchingConversation(w({ selectedConversationId: 'g-other' })), false)
    assert.equal(isWatchingConversation(w({ selectedConversationId: null })), false)
  })

  it('an app in the background is not watching, however it is navigated', () => {
    // The everyday case: cumora is on screen behind a browser, socket alive,
    // messages arriving, nobody reading them.
    assert.equal(isWatchingConversation(w({ attentive: false })), false)
  })

  it('desktop is not watching once the view leaves conversations', () => {
    // DesktopApp mounts views conditionally, so ChatPane is unmounted here —
    // the thread is not merely unfocused, it is not rendered at all.
    for (const view of ['boards', 'documents', 'calendar', 'agents', 'me', 'shipping']) {
      assert.equal(isWatchingConversation(w({ view })), false, `view=${view}`)
    }
  })

  it('mobile is not watching from the list or the info overlay', () => {
    // Swiping back only moves mobileStack; selectedConversationId stays put.
    assert.equal(isWatchingConversation(w({ mobileStack: 'list' })), false)
    assert.equal(isWatchingConversation(w({ mobileStack: 'info' })), false)
  })

  it('needs every condition at once, not just one of them', () => {
    // Guard against the predicate degrading into "selected" again.
    assert.equal(isWatchingConversation(w({ attentive: false, view: 'boards' })), false)
    assert.equal(isWatchingConversation(w({ mobileStack: 'list', attentive: false })), false)
  })
})

describe('subscribeWindowAttention', () => {
  /** Minimal DOM stand-ins: record which events were wired and let us fire them. */
  function stubDom(hasFocus: () => boolean) {
    const handlers = new Map<string, Set<() => void>>()
    const target = {
      addEventListener(type: string, fn: () => void) {
        if (!handlers.has(type)) handlers.set(type, new Set())
        handlers.get(type)!.add(fn)
      },
      removeEventListener(type: string, fn: () => void) { handlers.get(type)?.delete(fn) },
    }
    const g = globalThis as Record<string, unknown>
    const prevDoc = g.document
    const prevWin = g.window
    g.document = { ...target, visibilityState: 'visible', hasFocus }
    g.window = target
    return {
      handlers,
      fire(type: string) { for (const fn of handlers.get(type) ?? []) fn() },
      restore() { g.document = prevDoc; g.window = prevWin },
    }
  }

  it('listens for both edges of focus, not just the return', async () => {
    // Only listening for `focus` would leave a subscriber that never saw
    // attention drop — so it would never see it come back, and a badge earned
    // while the window was away would never clear.
    let focused = true
    const dom = stubDom(() => focused)
    try {
      const mod = await import('../src/lib/windowAttention')
      const seen: boolean[] = []
      const off = mod.subscribeWindowAttention((a) => seen.push(a))

      assert.ok(dom.handlers.has('focus'), 'no focus listener')
      assert.ok(dom.handlers.has('blur'), 'no blur listener — attention can never be observed dropping')
      assert.ok(dom.handlers.has('visibilitychange'), 'no visibilitychange listener')

      focused = false
      dom.fire('blur')
      focused = true
      dom.fire('focus')
      assert.deepEqual(seen, [false, true], 'both edges must reach the subscriber')

      off()
      dom.fire('focus')
      assert.deepEqual(seen, [false, true], 'unsubscribe did not detach the listeners')
    } finally {
      dom.restore()
    }
  })
})

describe('the callers that depend on it', () => {
  // Both predicates above are pure: every test so far passes just as well
  // against a build where the read path never calls them. These read the
  // source, because the defect was never in the predicate — it was in who asked.

  it('an arriving message is only read when the user is watching', async () => {
    const source = await readFile(new URL('../src/stores/conversations.ts', import.meta.url), 'utf8')
    const handler = source.slice(source.indexOf("e.type === 'message.new'"))
    const block = handler.slice(0, handler.indexOf("e.type === 'group.pulled'"))

    assert.match(block, /isWatchingConversation\(/,
      'incoming messages are marked read on selection alone again — an off-screen or backgrounded thread will silently clear its own badge')
    assert.match(block, /isWindowAttentive\(\)/,
      'the read decision no longer consults window attention')
    assert.doesNotMatch(block, /read: isActive/,
      'read is being decided by selection rather than by whether the user is watching')
  })

  it('the badge still clears the moment the user starts watching', async () => {
    // The other half. Without it a badge earned off screen would sit there
    // while the user stared straight at the messages.
    const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
    assert.match(source, /subscribeWindowAttention\(/,
      'App no longer tracks attention, so a badge earned off screen can never clear')
    assert.match(source, /\[convoId, selectedConvoExists, watching\]/,
      'the read effect is keyed on selection again — returning to a thread you were already on would not clear its badge')
  })

  it('desktop toasts still ask the same question', async () => {
    const source = await readFile(new URL('../src/components/NotificationToasts.tsx', import.meta.url), 'utf8')
    assert.match(source, /isWindowAttentive\(\)/)
    assert.match(source, /setNativeAppFocused/,
      'the Electron focus bridge no longer feeds the shared cache, so attention is stuck at its default')
  })
})
