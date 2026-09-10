/**
 * "Is the user actually looking at this app right now?"
 *
 * This used to be a private helper inside NotificationToasts, where it gated
 * desktop toasts: notify only when the app is NOT in front. It is shared now
 * because a second path needs the same answer and was getting it wrong.
 *
 * `stores/conversations` marks an arriving message read when it belongs to the
 * SELECTED conversation. Selected is not the same as watched: a window sitting
 * behind a browser is still "selected", still has a live socket, and still
 * receives every message. Those messages were marked read, the sidebar badge
 * was cleared, and `POST /conversations/:id/read` advanced the server's cursor
 * to NOW() — so nothing, not even a reload, could bring the count back. The
 * badge is the only "there is something new here" signal in the product; there
 * is no unread divider in the thread to fall back on.
 *
 * The decision is split from the globals it reads so it can be tested without
 * a DOM, which is how the rest of src/lib is arranged.
 */
import { isElectron } from '@/lib/runtime'

export interface AttentionEnv {
  /** `document.visibilityState`, or undefined outside a browser. */
  visibility: string | undefined
  /** Running inside the Electron shell. */
  electron: boolean
  /** The main process's view of native window focus. Only consulted in Electron. */
  nativeFocused: boolean
  /** `document.hasFocus()`, or undefined when unavailable. */
  hasFocus: boolean | undefined
}

/**
 * Hidden always wins: a minimized window, a background tab and a window on
 * another desktop all report hidden, and none of them is being read.
 *
 * In Electron we then trust the main process over `document.hasFocus()`, which
 * can return a stale `true` on macOS — believing it would suppress toasts (and,
 * now, hold back reads) for a window the user cannot see.
 *
 * On the web `hasFocus()` is all there is. When it is unavailable we assume the
 * user IS present: the alternative is a badge that never clears.
 */
export function evaluateAttention(env: AttentionEnv): boolean {
  if (env.visibility === 'hidden') return false
  if (env.electron) return env.nativeFocused
  if (env.hasFocus === false) return false
  return true
}

/** Renderer-side cache of the main window's native OS focus state, fed by
 *  `cumora.app.onFocusChange`. Optimistic default: a spurious "attentive" for
 *  half a second at boot is better than a toast storm or a stuck badge. */
let nativeAppFocused = true
const listeners = new Set<(attentive: boolean) => void>()

/** Called by the Electron focus bridge. Notifies subscribers when it flips. */
export function setNativeAppFocused(focused: boolean): void {
  if (nativeAppFocused === focused) return
  nativeAppFocused = focused
  const attentive = isWindowAttentive()
  for (const listener of listeners) listener(attentive)
}

/** Fires whenever attention may have changed. Returns an unsubscribe. */
export function subscribeWindowAttention(listener: (attentive: boolean) => void): () => void {
  listeners.add(listener)
  const onDomChange = (): void => { listener(isWindowAttentive()) }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onDomChange)
  }
  if (typeof window !== 'undefined') {
    // Both edges. Listening only for `focus` would leave a subscriber that
    // never saw attention drop, so it would never see it return either — and a
    // badge earned while the window was away would never clear.
    window.addEventListener('focus', onDomChange)
    window.addEventListener('blur', onDomChange)
  }
  return () => {
    listeners.delete(listener)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onDomChange)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onDomChange)
      window.removeEventListener('blur', onDomChange)
    }
  }
}

/** The live answer, read from the current environment. */
export function isWindowAttentive(): boolean {
  if (typeof document === 'undefined') return true
  return evaluateAttention({
    visibility: document.visibilityState,
    electron: isElectron,
    nativeFocused: nativeAppFocused,
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : undefined,
  })
}
