/**
 * Admin panel root. Mounted by App.tsx when the request hostname is
 * admin.cumora.ai (or the path starts with /admin in localhost dev).
 *
 * Auth is delegated to the same AuthGate the main app uses — once
 * signed in via OAuth, AdminApp checks /api/admin/me and either
 * renders the panel or shows a "not authorized" screen. There is no
 * client-side admin login; you sign in normally first, then visit
 * admin.cumora.ai.
 *
 * Routing is a tiny pathname-based switcher because the rest of cumora
 * doesn't use react-router and we'd rather not pull it in just for
 * three top-level pages. On admin.cumora.ai the basePath is `/`; on
 * localhost dev (or any host where the panel mounts under `/admin`)
 * the basePath is `/admin`.
 */
import { useEffect, useState } from 'react'
import { useAuth } from '@/stores/auth'
import { useT } from '@/lib/i18n'
import { CloudLogo } from '@/components/Avatar'
import { adminApi, type AdminStats } from './api'
import { UsersPage } from './UsersPage'
import { WaitlistPage } from './WaitlistPage'
import { SettingsPage } from './SettingsPage'
import { ObservabilityPage } from './ObservabilityPage'

type Route = 'users' | 'waitlist' | 'settings' | 'observability'

/** Empty string on admin.cumora.ai, `/admin` on localhost dev. Kept as
 *  a function (not a constant) so tests / SSR don't crash on a missing
 *  `location`. */
function getBasePath(): string {
  if (typeof location === 'undefined') return ''
  if (location.pathname.startsWith('/admin')) return '/admin'
  return ''
}

function parseRoute(): Route {
  const base = getBasePath()
  let rest = location.pathname
  if (base && rest.startsWith(base)) rest = rest.slice(base.length)
  rest = rest.replace(/^\/+/, '').replace(/\/+$/, '')
  if (rest.startsWith('waitlist')) return 'waitlist'
  if (rest.startsWith('settings')) return 'settings'
  if (rest.startsWith('observability')) return 'observability'
  return 'users'
}

function hrefFor(target: Route): string {
  const base = getBasePath()
  return `${base}/${target}`
}

export function AdminApp() {
  const t = useT()
  const user = useAuth((s) => s.user)
  const clear = useAuth((s) => s.clear)
  const [route, setRoute] = useState<Route>(parseRoute)
  const [verified, setVerified] = useState<'checking' | 'admin' | 'denied'>('checking')
  const [stats, setStats] = useState<AdminStats | null>(null)
  // Mobile nav drawer. Auto-closes after each navigation so a phone
  // user doesn't have to dismiss it manually after picking a route.
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => { setNavOpen(false) }, [route])

  useEffect(() => {
    const onPop = () => setRoute(parseRoute())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Verify admin status server-side. The user store already has an
  // `isAdmin` flag from /auth/me, but we re-check against /api/admin/me
  // so a flipped bit on the server takes effect immediately without a
  // refresh, AND so the failure mode (network / 403) shows a real error
  // instead of silently rendering an empty panel.
  useEffect(() => {
    let cancelled = false
    adminApi.me()
      .then(() => { if (!cancelled) setVerified('admin') })
      .catch(() => { if (!cancelled) setVerified('denied') })
    return () => { cancelled = true }
  }, [user?.id])

  useEffect(() => {
    if (verified !== 'admin') return
    void adminApi.stats().then(setStats).catch(() => { /* swallow */ })
  }, [verified, route])

  if (verified === 'checking') {
    return <FullScreenNote tone="muted">{t('admin.checking')}</FullScreenNote>
  }
  if (verified === 'denied') {
    return (
      <FullScreenNote tone="warn">
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{t('admin.notAuthorized')}</div>
        <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 16 }}>
          {t('admin.signedInAs', { email: user?.email ?? '(unknown)' })}
        </div>
        <button type="button" className="btn" onClick={() => { clear() }}>
          {t('admin.signOutSwitch')}
        </button>
      </FullScreenNote>
    )
  }

  return (
    <div className={`admin-shell${navOpen ? ' nav-open' : ''}`}>
      <header className="admin-topbar">
        <button type="button" className="admin-topbar-burger" onClick={() => setNavOpen((v) => !v)} aria-label={t('admin.toggleNav')}>
          <span /><span /><span />
        </button>
        <div className="admin-topbar-brand">
          <CloudLogo size={24} />
          <span>cumora admin</span>
        </div>
        <div className="admin-topbar-spacer" />
      </header>
      {navOpen && <div className="admin-nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <CloudLogo size={32} />
          <div>
            <div className="admin-brand-title">cumora admin</div>
            <div className="admin-brand-sub">{user?.email}</div>
          </div>
        </div>
        <nav className="admin-nav">
          <NavLink current={route} target="users"         label={t('admin.users')}         badge={stats?.users.total} />
          <NavLink current={route} target="waitlist"      label={t('admin.waitlist')}      badge={stats?.waitlist.pending || undefined} highlight={!!stats?.waitlist.pending} />
          <NavLink current={route} target="observability" label={t('admin.observability')} />
          <NavLink current={route} target="settings"      label={t('admin.settings')} />
        </nav>
        <div className="admin-sidebar-foot">
          <button type="button" className="btn-ghost" onClick={() => { clear() }}>{t('admin.signOut')}</button>
        </div>
      </aside>
      <main className="admin-main">
        {route === 'users'         && <UsersPage stats={stats} />}
        {route === 'waitlist'      && <WaitlistPage onChanged={() => {
          // Refresh stats so the sidebar badge clears immediately.
          void adminApi.stats().then(setStats).catch(() => {})
        }} />}
        {route === 'observability' && <ObservabilityPage />}
        {route === 'settings'      && <SettingsPage />}
      </main>
    </div>
  )
}

function NavLink({ current, target, label, badge, highlight }: {
  current: Route; target: Route; label: string; badge?: number; highlight?: boolean
}) {
  const active = current === target
  const href = hrefFor(target)
  return (
    <a
      href={href}
      className={`admin-nav-link${active ? ' is-active' : ''}`}
      onClick={(e) => {
        // Plain-left click without modifiers → SPA navigation. Modifier
        // clicks (cmd/ctrl/shift/middle) fall through so "open in new
        // tab" still works.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        if (location.pathname === href) return
        window.history.pushState(null, '', href)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }}
    >
      <span>{label}</span>
      {typeof badge === 'number' && badge > 0 && (
        <span className={`admin-pill${highlight ? ' admin-pill-warn' : ''}`}>{badge}</span>
      )}
    </a>
  )
}

function FullScreenNote({ children, tone }: { children: React.ReactNode; tone: 'muted' | 'warn' }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, color: tone === 'warn' ? 'var(--coral-deep)' : 'var(--ink-500)',
      background: 'var(--paper)', fontFamily: 'inherit',
    }}>
      <div style={{ textAlign: 'center', maxWidth: 420 }}>{children}</div>
    </div>
  )
}
