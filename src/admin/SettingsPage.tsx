/**
 * Global toggles. Each toggle is a single boolean call to /settings.
 * Renders pessimistically — disable the row while the request flies so
 * a fast double-click doesn't race the server.
 */
import { useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'
import { adminApi, type AdminSettings } from './api'

export function SettingsPage() {
  const t = useT()
  const [s, setS] = useState<AdminSettings | null>(null)
  const [busyKey, setBusyKey] = useState<keyof AdminSettings | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    adminApi.settings()
      .then(setS)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  const flip = async (key: keyof AdminSettings) => {
    if (!s || busyKey) return
    setBusyKey(key); setErr(null)
    try {
      const next = await adminApi.setSettings({ [key]: !s[key] })
      setS(next)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusyKey(null) }
  }

  return (
    <div className="admin-page">
      <header className="admin-page-head">
        <div>
          <h1 className="admin-h1">{t('adminSettings.title')}</h1>
          <div className="admin-sub">{t('adminSettings.sub')}</div>
        </div>
      </header>

      {err && <div className="admin-banner-err">{err}</div>}

      <div className="admin-settings">
        <SettingRow
          title={t('adminSettings.waitlistTitle')}
          desc={t('adminSettings.waitlistDesc')}
          on={!!s?.waitlist_enabled}
          busy={busyKey === 'waitlist_enabled'}
          disabled={!s}
          onToggle={() => void flip('waitlist_enabled')}
        />
        <SettingRow
          title={t('adminSettings.signupsPausedTitle')}
          desc={t('adminSettings.signupsPausedDesc')}
          on={!!s?.signups_paused}
          busy={busyKey === 'signups_paused'}
          disabled={!s}
          onToggle={() => void flip('signups_paused')}
        />
      </div>
    </div>
  )
}

function SettingRow({ title, desc, on, busy, disabled, onToggle }: {
  title: string; desc: string; on: boolean; busy: boolean; disabled: boolean; onToggle: () => void
}) {
  return (
    <div className="admin-setting">
      <div>
        <div className="admin-setting-title">{title}</div>
        <div className="admin-setting-desc">{desc}</div>
      </div>
      <button
        type="button"
        className={`admin-switch${on ? ' is-on' : ''}`}
        onClick={onToggle}
        disabled={disabled || busy}
        aria-pressed={on}
      >
        <span className="admin-switch-thumb" />
      </button>
    </div>
  )
}
