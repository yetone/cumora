import { Component, type ErrorInfo, type ReactNode } from 'react'
import { translate, useLocaleStore } from '@/lib/i18n'

interface Props { children: ReactNode }
interface State { error: Error | null; resetKey: number }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface in the console so devtools shows the full stack + the
    // React component stack (which the default fallback drops).
    console.error('[ErrorBoundary] caught', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      const locale = useLocaleStore.getState().locale
      const t = (key: Parameters<typeof translate>[1]) => translate(locale, key)
      return (
        <div className="fixed inset-0 grid place-items-center bg-paper p-8">
          <div className="max-w-[460px] text-center">
            <div className="font-display font-medium text-[32px] tracking-tight text-ink-900 mb-2"
              style={{ letterSpacing: '-0.025em' }}>
              {t('errorBoundary.somethingCracked')}
            </div>
            <div className="font-display italic text-[14px] text-ink-500 leading-relaxed mb-5">
              {t('errorBoundary.fallbackBody')}
            </div>
            <pre
              className="text-left text-[11.5px] font-mono text-ink-700 bg-cloud rounded-[10px] py-2.5 px-3 mb-5 overflow-x-auto whitespace-pre-wrap break-words"
              style={{ border: '1px solid var(--ink-100)', maxHeight: 160 }}
            >
              {this.state.error.message || String(this.state.error)}
            </pre>
            <div className="flex gap-2 justify-center">
              <button
                type="button"
                onClick={() => this.setState({ error: null, resetKey: this.state.resetKey + 1 })}
                className="py-2 px-4 rounded-[10px] text-[13px] font-semibold text-white"
                style={{
                  background: 'linear-gradient(135deg, var(--skype), var(--skype-deep))',
                  boxShadow: '0 6px 16px -4px rgba(0, 168, 240, 0.45)',
                }}
              >{t('errorBoundary.resetView')}</button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="py-2 px-4 rounded-[10px] text-[13px] font-semibold text-ink-700 bg-cloud"
                style={{ border: '1px solid var(--ink-100)' }}
              >{t('errorBoundary.reload')}</button>
            </div>
          </div>
        </div>
      )
    }
    // The resetKey forces React to remount children when "Reset view"
    // is pressed — wipes any persisted in-component state that may
    // have caused the crash without dropping the auth session.
    return <div key={this.state.resetKey}>{this.props.children}</div>
  }
}
