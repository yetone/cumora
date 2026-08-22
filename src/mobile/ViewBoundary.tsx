/**
 * ViewBoundary — last-resort error boundary for a mobile tab.
 *
 * Wraps the tree of one tab (Whispers / Library / Agents / Me /
 * Chats) so a render-time throw in any one of them doesn't crash
 * the whole shell into a permanent white screen. Instead the user
 * sees a "this tab hit a snag — tap to retry" panel and the rest
 * of the navigation stays intact.
 *
 * `key={view}` on the boundary lets the parent reset state by
 * remounting whenever the active tab changes; the user landing on
 * a fresh tab always gets a fresh boundary.
 */
import { Component, type ReactNode } from 'react'
import { translate, useLocaleStore, type MessageKey } from '@/lib/i18n'

interface Props {
  /** Human-readable tab name shown in the fallback copy. */
  name: string
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ViewBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    // Surface to console so the diagnostic tile / a remote logger
    // can pick it up — the white-screen-without-a-trace case was
    // largely invisible before this boundary existed.
    console.error(`[ViewBoundary] "${this.props.name}" crashed:`, error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      // Class component — read the locale snapshot at render time. The
      // locale store is a plain zustand slice; useLocaleStore.getState()
      // gives us a fresh value on every render without re-subscribing
      // (we don't need reactivity inside this once-per-error render).
      const locale = useLocaleStore.getState().locale
      const t = (k: MessageKey, vars?: Record<string, string | number>) => translate(locale, k, vars)
      return (
        <div className="absolute inset-0 grid place-items-center bg-paper p-8 text-center">
          <div className="max-w-[280px]">
            <div className="font-display text-[18px] text-ink-900 mb-2">
              {t('viewBoundary.hitASnag', { name: this.props.name })}
            </div>
            <div className="font-display italic text-[13px] text-ink-500 leading-snug mb-5">
              {this.state.error.message || t('viewBoundary.fallbackMsg')}
            </div>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="h-10 px-5 rounded-[10px] text-[13px] font-semibold text-white"
              style={{ background: 'var(--skype)' }}
            >{t('viewBoundary.tryAgain')}</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
