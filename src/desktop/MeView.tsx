import { useEffect, useState } from 'react'
import { useParticipants } from '@/stores/participants'
import { useComputers } from '@/stores/computers'
import { usePrefs } from '@/stores/preferences'
import { useSoundStore } from '@/stores/sound'
import { useDevtools } from '@/stores/devtools'
import { useAuth } from '@/stores/auth'
import { Avatar } from '@/components/Avatar'
import { Checkbox } from '@/components/Checkbox'
import { AppearancePicker } from '@/components/AppearancePicker'
import { LanguagePicker } from '@/components/LanguagePicker'
import { useT, type MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { isWindows } from '@/lib/runtime'
import { api, getPairingServerOrigin, getServerOrigin, type ApiProject, type ApiQuotaSnapshot, type ApiQuotaWindow } from '@/api/client'

// The tab's identity is its `key`; the label is a message key resolved at
// render. Before this they were the same string, which would have made
// the active tab depend on the UI language.
const tabs = [
  { key: 'profile', label: 'me.tab.profile' },
  { key: 'usage', label: 'me.tab.usage' },
  { key: 'computers', label: 'me.tab.computers' },
  { key: 'projects', label: 'me.tab.projects' },
  { key: 'trust', label: 'me.tab.trust' },
  { key: 'preferences', label: 'me.tab.preferences' },
] as const satisfies ReadonlyArray<{ key: string; label: MessageKey }>
type Tab = (typeof tabs)[number]['key']

// `lbl` / `sub` are message keys — the preference `key` is the server-side
// identifier and never changes with the language.
const PREF_GROUPS: Array<{ title: MessageKey; items: Array<{ key: string; lbl: MessageKey; sub: MessageKey; default: boolean }> }> = [
  {
    title: 'me.prefs.notifications',
    items: [
      { key: 'notify.group_pulled', lbl: 'me.prefs.groupPulled', sub: 'me.prefs.groupPulledSub', default: true },
      { key: 'notify.whisper_mention', lbl: 'me.prefs.whisperMention', sub: 'me.prefs.whisperMentionSub', default: true },
      { key: 'notify.convene_called', lbl: 'me.prefs.conveneCalled', sub: 'me.prefs.conveneCalledSub', default: true },
      { key: 'notify.daily_summary', lbl: 'me.prefs.dailySummary', sub: 'me.prefs.dailySummarySub', default: false },
    ],
  },
  {
    title: 'me.prefs.lookFeel',
    items: [
      { key: 'ui.reduce_motion', lbl: 'me.prefs.reduceMotion', sub: 'me.prefs.reduceMotionSub', default: false },
      { key: 'ui.typing_indicators', lbl: 'me.prefs.typingIndicators', sub: 'me.prefs.typingIndicatorsSub', default: true },
      { key: 'ui.thoughts_in_main', lbl: 'me.prefs.thoughtsInMain', sub: 'me.prefs.thoughtsInMainSub', default: false },
    ],
  },
  {
    title: 'me.prefs.privacy',
    items: [
      { key: 'priv.allow_silent_whispers', lbl: 'me.prefs.silentWhispers', sub: 'me.prefs.silentWhispersSub', default: true },
      { key: 'priv.allow_new_tools', lbl: 'me.prefs.newTools', sub: 'me.prefs.newToolsSub', default: true },
      { key: 'priv.allow_human_invites', lbl: 'me.prefs.humanInvites', sub: 'me.prefs.humanInvitesSub', default: false },
    ],
  },
]

function ProfileTab() {
  // Pull both the auth user (real account: id, email, providers) and the
  // matching participant (for avatar). They're usually the same person but
  // participant rows can lag in the local cache, so we don't gate on it.
  const t = useT()
  const authUser = useAuth((s) => s.user)
  const meParticipant = useParticipants((s) => (authUser ? s.byId[authUser.id] : null))
  const serverOrigin = getServerOrigin() || 'same-origin (Vite proxy)'

  async function signOut() {
    // Server-side: revoke the session row so the token is dead even if it
    // leaks. Best-effort — client clear still happens on network failure.
    try { await api.authLogout() } catch (e) { console.warn('[signout] server call failed', e) }
    useAuth.getState().clear()
    location.reload()
  }

  if (!authUser) return null
  const providers = authUser.providers ?? []
  return (
    <div className="space-y-6">
      <Section title={t('me.sectionIdentity')}>
        <div className="bg-cloud rounded-[14px] p-5 flex items-start gap-5"
          style={{ border: '1px solid var(--ink-100)' }}>
          {meParticipant
            ? <Avatar p={meParticipant} size={88} />
            : <div className="w-[88px] h-[88px] rounded-full bg-ink-100" />}
          <div className="flex-1 min-w-0">
            <h2 className="font-display font-medium text-[26px] tracking-tight truncate" style={{ letterSpacing: '-0.02em' }}>{authUser.name}</h2>
            <div className="font-display italic text-[14px] text-ink-500 truncate">{authUser.email}</div>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              {providers.map((p) => (
                <span key={p} className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-white text-ink-600" style={{ border: '1px solid var(--ink-100)' }}>
                  {p}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section title={t('me.sectionSession')}>
        <div className="bg-cloud rounded-[14px] p-5 flex items-center justify-between gap-4"
          style={{ border: '1px solid var(--ink-100)' }}>
          <div className="min-w-0">
            <div className="font-display text-[14px] text-ink-800">{t('me.sessionTitle', { server: serverOrigin })}</div>
            <div className="font-display italic text-[12px] text-ink-400 mt-0.5">
              {t('me.sessionHint')}
            </div>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="shrink-0 h-9 px-4 rounded-[8px] bg-ink-800 hover:bg-ink-900 text-white text-[13px] font-display transition-colors"
          >
            {t('common.signOut')}
          </button>
        </div>
      </Section>

      <CommunitySection />

      <AboutSection />
    </div>
  )
}

/** Discord invite. Renders on every platform (web + desktop) so feedback
 *  has a single, advertised entry point that doesn't go through email. */
function CommunitySection() {
  const t = useT()
  return (
    <Section title={t('me.sectionCommunity')}>
      <div className="bg-cloud rounded-[14px] p-5 flex items-center justify-between gap-4"
        style={{ border: '1px solid var(--ink-100)' }}>
        <div className="min-w-0">
          <div className="font-display text-[14px] text-ink-800">{t('me.communityTitle')}</div>
          <div className="font-display italic text-[12px] text-ink-400 mt-0.5">
            {t('me.communityHint')}
          </div>
        </div>
        <a
          href="https://discord.gg/hzfcsB6vMr"
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 h-9 px-4 rounded-[8px] text-[13px] font-display transition-colors text-white inline-flex items-center gap-2"
          style={{ background: '#5865F2' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
          </svg>
          {t('me.joinDiscord')}
        </a>
      </div>
    </Section>
  )
}

/** Cumora version + auto-update entry point. Renders only when the
 *  Electron bridge is available (PWA / web builds have no updater).
 *  Click "Check for updates" → opens the UpdaterDialog mounted at the
 *  AuthedApp level via a custom window event (avoids prop-drilling
 *  through three layers of view components). */
function AboutSection() {
  const t = useT()
  const [version, setVersion] = useState<string | null>(null)
  const [supported, setSupported] = useState<boolean>(false)

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.cumora?.update : undefined
    if (!bridge) return
    void bridge.getAppInfo().then((info) => {
      setVersion(info.version)
      setSupported(info.autoUpdateSupported)
    }).catch(() => { /* swallow — section just hides */ })
  }, [])

  if (!version) return null

  return (
    <Section title={t('me.sectionAbout')}>
      <div className="bg-cloud rounded-[14px] p-5 flex items-center justify-between gap-4"
        style={{ border: '1px solid var(--ink-100)' }}>
        <div className="min-w-0">
          <div className="font-display text-[14px] text-ink-800">{t('me.versionLine', { version })}</div>
          <div className="font-display italic text-[12px] text-ink-400 mt-0.5">
            {supported ? t('me.autoUpdateDaily') : t('me.autoUpdateUnsupported')}
          </div>
        </div>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('cumora:open-updater'))}
          className="shrink-0 h-9 px-4 rounded-[8px] text-[13px] font-display transition-colors text-white"
          style={{ background: 'var(--skype)' }}
        >
          {t('me.checkUpdates')}
        </button>
      </div>
    </Section>
  )
}

/* ============================ Usage / Quota ============================
 * Three rounded "weather cards" — daily / weekly / monthly — mirroring
 * the cumora cloud-and-paper feel. The bars use --skype on a faint
 * sky2-100 track until usage crosses 75% (turns coral) and 95% (deep
 * coral with a quiet pulse). Numbers come from sub2api's subscription
 * summary; everything is best-effort — missing data renders a soft
 * "unavailable" card rather than a hard error. */

type PeriodKey = 'daily' | 'weekly' | 'monthly'

const PERIOD_META: Array<{ key: PeriodKey; label: MessageKey; sub: MessageKey }> = [
  { key: 'daily',   label: 'me.periodDaily',   sub: 'me.rolloverDaily' },
  { key: 'weekly',  label: 'me.periodWeekly',  sub: 'me.rolloverWeekly' },
  { key: 'monthly', label: 'me.periodMonthly', sub: 'me.rolloverMonthly' },
]

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  if (n < 10) return `$${n.toFixed(2)}`
  if (n < 1000) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString()}`
}

/** Best-effort "resets in 3h" / "resets in 2d" string. Falls back to a
 *  blank string when sub2api didn't hand back a window start (older
 *  rows). The period length is fixed (24h / 7d / ~30d) — sub2api uses
 *  rolling windows, so we count forward from window_start. */
function resetsHint(t: (k: MessageKey, params?: Record<string, string | number>) => string, period: PeriodKey, windowStart: string | null): string {
  if (!windowStart) return ''
  const start = new Date(windowStart).getTime()
  if (Number.isNaN(start)) return ''
  const lenMs = period === 'daily' ? 86_400_000
              : period === 'weekly' ? 7 * 86_400_000
              : 30 * 86_400_000
  const remaining = start + lenMs - Date.now()
  if (remaining <= 0) return t('me.resetsSoon')
  const h = Math.floor(remaining / 3_600_000)
  if (h < 1) {
    const m = Math.max(1, Math.floor(remaining / 60_000))
    return t('me.resetsInMinutes', { n: m })
  }
  if (h < 48) return t('me.resetsInHours', { n: h })
  const d = Math.floor(h / 24)
  return t('me.resetsInDays', { n: d })
}

function QuotaCard({ period, label, sub, window }: {
  period: PeriodKey
  label: MessageKey
  sub: MessageKey
  window: ApiQuotaWindow | null
}) {
  const t = useT()
  const used = window?.usedUsd ?? 0
  const limit = window?.limitUsd ?? null
  const pct = limit != null && limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  // Tone shifts as the user gets close to the cap. Default is the brand
  // skype blue; coral takes over past the 75% mark so a glance at the
  // cards still tells the user "you're fine" vs "slow down".
  const tone = limit == null ? 'neutral'
             : pct >= 95 ? 'danger'
             : pct >= 75 ? 'warn'
             : 'ok'
  const barColor = tone === 'danger' ? 'var(--coral-deep, #C84E3F)'
                 : tone === 'warn'   ? 'var(--coral, #FF7A6B)'
                 : tone === 'ok'     ? 'var(--skype, #00A8F0)'
                 : 'var(--ink-300, #94A8BC)'
  const resets = window ? resetsHint(t, period, window.windowStart) : ''
  return (
    <div className="bg-cloud rounded-[14px] p-5 flex flex-col gap-3"
      style={{ border: '1px solid var(--ink-100)' }}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-display font-semibold text-[14px] text-ink-900">{t(label)}</div>
        {limit != null
          ? <div className="font-mono text-[11px] font-semibold text-ink-500">{pct.toFixed(0)}%</div>
          : <div className="font-mono text-[10px] tracking-wider uppercase text-ink-300">{t('me.unlimited')}</div>}
      </div>
      <div className="font-display tabular-nums text-[22px] tracking-tight text-ink-900" style={{ letterSpacing: '-0.02em' }}>
        {fmtUsd(used)}
        <span className="text-ink-300 text-[15px] font-normal"> / {limit != null ? fmtUsd(limit) : '∞'}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--sky2-100, #E1F3FD)' }}>
        <div
          className="h-full rounded-full transition-[width,background-color,opacity] duration-500"
          style={{
            width: limit != null ? `${Math.max(2, pct)}%` : '100%',
            background: barColor,
            opacity: limit != null ? 1 : 0.35,
          }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-display italic text-ink-400">{t(sub)}</span>
        {resets && <span className="font-mono text-ink-500">{resets}</span>}
      </div>
    </div>
  )
}

function UsageTab() {
  const t = useT()
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; configured: boolean; snapshot: ApiQuotaSnapshot | null; error?: string }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' })

  const load = () => {
    setState({ kind: 'loading' })
    api.getQuota()
      .then((r) => setState({ kind: 'ready', configured: r.configured, snapshot: r.snapshot, error: r.error }))
      .catch((e) => setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }))
  }
  useEffect(load, [])

  if (state.kind === 'loading') {
    return (
      <div className="space-y-6">
        <Section title={t('me.sectionQuota')}>
          <div className="grid grid-cols-3 gap-3">
            {PERIOD_META.map((p) => (
              <div key={p.key} className="bg-cloud rounded-[14px] p-5 h-[140px]"
                style={{ border: '1px solid var(--ink-100)' }}>
                <div className="font-display font-semibold text-[14px] text-ink-300">{t(p.label)}</div>
                <div className="font-display italic text-[12px] text-ink-300 mt-2">{t('common.loading')}</div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="space-y-6">
        <Section title={t('me.sectionQuota')}>
          <div className="bg-cloud rounded-[14px] p-6 text-center"
            style={{ border: '1px solid var(--ink-100)' }}>
            <div className="font-display text-[14px] text-ink-700 mb-1">{t('me.quotaFetchFailed')}</div>
            <div className="font-display italic text-[12px] text-coral-deep mb-3">{state.message}</div>
            <button onClick={load}
              className="px-4 py-1.5 rounded-[8px] text-[12px] font-semibold text-white"
              style={{ background: 'var(--skype)' }}>
              {t('common.tryAgain')}
            </button>
          </div>
        </Section>
      </div>
    )
  }

  // ready
  const { configured, snapshot, error } = state
  if (!configured) {
    return (
      <div className="space-y-6">
        <Section title={t('me.sectionQuota')}>
          <div className="bg-cloud rounded-[14px] p-6"
            style={{ border: '1px dashed var(--ink-100)' }}>
            <div className="font-display text-[14px] text-ink-700">{t('me.noQuotaGateway')}</div>
            <div className="font-display italic text-[12px] text-ink-500 mt-1 max-w-xl">
              {t('me.noQuotaHint')}
            </div>
          </div>
        </Section>
      </div>
    )
  }

  if (!snapshot) {
    return (
      <div className="space-y-6">
        <Section title={t('me.sectionQuota')}>
          <div className="bg-cloud rounded-[14px] p-6"
            style={{ border: '1px dashed var(--ink-100)' }}>
            <div className="font-display text-[14px] text-ink-700">
              {error ? t('me.quotaUnreachable') : t('me.noActiveSub')}
            </div>
            <div className="font-display italic text-[12px] text-ink-500 mt-1 max-w-xl">
              {error ? t('me.quotaGatewayUnreachHint') : t('me.subNotProvisioned')}
            </div>
            <button onClick={load}
              className="mt-3 px-4 py-1.5 rounded-[8px] text-[12px] font-semibold text-skype-deep bg-cloud hover:bg-sky2-50 transition"
              style={{ border: '1px dashed var(--sky2-300)' }}>
              {t('me.refresh')}
            </button>
          </div>
        </Section>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Section title={t('me.sectionQuota')}>
        <div className="text-[13px] text-ink-500 leading-[1.55] mb-4 max-w-2xl font-display italic">
          {t('me.quotaIntro')}
          {snapshot.groupName ? <> {t('me.quotaIntroPlan', { plan: snapshot.groupName })}</> : null}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {PERIOD_META.map((p) => (
            <QuotaCard
              key={p.key}
              period={p.key}
              label={p.label}
              sub={p.sub}
              window={snapshot[p.key]}
            />
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={load}
            className="px-4 py-1.5 rounded-[8px] text-[12px] font-semibold text-skype-deep bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}>
            {t('me.refresh')}
          </button>
          {error && <span className="text-[11.5px] text-coral-deep font-display italic">{t('me.refreshFailed', { msg: error })}</span>}
        </div>
      </Section>
    </div>
  )
}

function TrustTab() {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const autonomy = usePrefs((s) => s.autonomy)
  const setAutonomy = usePrefs((s) => s.setAutonomy)
  const agents = Object.values(byId).filter((p) => p.kind === 'agent')

  return (
    <div className="space-y-6">
      <Section title={t('me.sectionPerAgent')}>
        <div className="text-[13px] text-ink-500 leading-[1.55] mb-4 max-w-2xl font-display italic">
          {t('me.perAgentIntro')}
        </div>
        <div className="space-y-2">
          {agents.map((a) => {
            const trust = autonomy[a.id]?.threshold ?? 0.6
            return (
              <div key={a.id} className="bg-cloud rounded-[12px] p-4 grid grid-cols-[184px_minmax(0,1fr)] items-center gap-5"
                style={{ border: '1px solid var(--ink-100)' }}>
                <div className="flex items-center gap-4 min-w-0">
                  <Avatar p={a} size={36} showStatus={false} />
                  <div className="min-w-0">
                    <div className="font-bold text-[13.5px] text-ink-900 truncate">{a.name}</div>
                    <div className="font-display italic text-[11.5px] text-ink-500 truncate">{a.role}</div>
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] text-ink-500 mb-1.5 flex justify-between">
                    <span>{t('me.autonomyThreshold')}</span>
                    <span className="font-mono text-[11px] font-semibold text-ink-700">{trust.toFixed(2)}</span>
                  </div>
                  <input type="range" min={0} max={1} step={0.01} value={trust}
                    onChange={(e) => setAutonomy(a.id, parseFloat(e.target.value))}
                    className="w-full accent-whisper" />
                </div>
              </div>
            )
          })}
        </div>
      </Section>

      <Section title={t('me.sectionTrackRecords')}>
        <div className="grid grid-cols-3 gap-3">
          {agents.slice(0, 3).map((a) => {
            const ar = autonomy[a.id]
            return (
              <div key={a.id} className="bg-cloud rounded-[12px] p-4"
                style={{ border: '1px solid var(--ink-100)' }}>
                <div className="flex items-center gap-2.5 mb-3">
                  <Avatar p={a} size={28} showStatus={false} />
                  <div className="font-bold text-[13px] text-ink-900">{a.name}</div>
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-center">
                  <Stat n={ar?.pulled ?? 0} l="me.statPulled" tone="good" />
                  <Stat n={ar?.led ?? 0} l="me.statLed" tone="good" />
                  <Stat n={ar?.dissolved ?? 0} l="me.statNoise" tone="warn" />
                </div>
              </div>
            )
          })}
        </div>
      </Section>
    </div>
  )
}

function Stat({ n, l, tone }: { n: number; l: MessageKey; tone: 'good' | 'warn' }) {
  const t = useT()
  return (
    <div>
      <div className="font-display text-[20px] font-medium" style={{ color: tone === 'good' ? 'var(--avail)' : 'var(--coral-deep)' }}>{n}</div>
      <div className="text-[9px] font-bold text-ink-300 uppercase tracking-wider">{t(l)}</div>
    </div>
  )
}

function ProjectsTab() {
  const t = useT()
  const [projects, setProjects] = useState<ApiProject[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = () => {
    void api.listProjects().then(setProjects).catch(() => { /* ignore */ })
  }
  useEffect(refresh, [])

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true); setErr(null)
    try {
      await api.createProject({ name: trimmed, description: description.trim() })
      setName(''); setDescription(''); setCreating(false); refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const archive = async (id: string, archive: boolean) => {
    try { await api.archiveProject(id, archive); refresh() }
    catch (e) { console.warn('[projects] archive failed', e) }
  }

  const visible = showArchived ? projects : projects.filter((p) => p.status === 'active')
  const archivedCount = projects.filter((p) => p.status === 'archived').length

  return (
    <div className="space-y-6">
      <Section title={t('me.sectionProjects')}>
        <div className="text-[13px] text-ink-500 leading-[1.55] mb-4 max-w-2xl font-display italic">
          {t('me.projectsIntro')}
        </div>

        <div className="space-y-2">
          {visible.length === 0 && !creating && (
            <div className="bg-cloud rounded-[12px] p-6 text-center text-[13px] text-ink-500 italic font-display"
              style={{ border: '1px dashed var(--ink-100)' }}>
              {t('me.noProjects')}
            </div>
          )}
          {visible.map((p) => {
            const count = p.conversationCount
            return (
              <div key={p.id} className="bg-cloud rounded-[12px] p-4 flex items-center gap-4"
                style={{ border: '1px solid var(--ink-100)', opacity: p.status === 'archived' ? 0.55 : 1 }}>
                <div className="w-3 h-10 rounded-full shrink-0" style={{ background: p.color ?? 'var(--ink-200)' }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="font-semibold text-[14px] text-ink-900 truncate">{p.name}</div>
                    {p.status === 'archived' && <span className="text-[10px] text-ink-300 uppercase tracking-wider">{t('me.archived')}</span>}
                  </div>
                  <div className="font-display italic text-[12px] text-ink-500 truncate">
                    {p.description || t('me.noDescription')}  ·  {count === 1 ? t('me.projectConvoCount', { n: count }) : t('me.projectConvoCountPlural', { n: count })}
                  </div>
                </div>
                <button
                  onClick={() => archive(p.id, p.status !== 'archived')}
                  className="px-3 py-1.5 rounded-[8px] text-[11.5px] font-semibold text-ink-700 bg-paper hover:bg-sky2-50 transition"
                  style={{ border: '1px solid var(--ink-100)' }}
                >{p.status === 'archived' ? t('me.restore') : t('me.archive')}</button>
              </div>
            )
          })}
        </div>

        {creating ? (
          <div className="mt-4 bg-cloud rounded-[12px] p-4 space-y-2"
            style={{ border: '1.5px solid var(--sky2-300)' }}>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('me.projectNamePh')}
              className="w-full px-3 py-2 text-[13px] rounded outline-none"
              style={{ border: '1px solid var(--ink-100)', background: 'var(--paper)' }}
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('me.projectDescPh')}
              className="w-full px-3 py-2 text-[12.5px] rounded outline-none"
              style={{ border: '1px solid var(--ink-100)', background: 'var(--paper)' }}
            />
            {err && <div className="text-[11.5px] text-coral-deep">{err}</div>}
            <div className="flex gap-2">
              <button
                onClick={create}
                disabled={!name.trim() || busy}
                className="px-4 py-1.5 rounded-[8px] text-[12px] font-semibold text-white disabled:opacity-50"
                style={{ background: 'var(--skype)' }}
              >{busy ? t('me.createProjectBusy') : t('me.createProject')}</button>
              <button
                onClick={() => { setCreating(false); setName(''); setDescription(''); setErr(null) }}
                className="px-3 py-1.5 rounded-[8px] text-[12px] text-ink-500 hover:bg-cloud"
              >{t('common.cancel')}</button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => setCreating(true)}
              className="px-4 py-2 rounded-[10px] text-[12.5px] font-semibold text-skype-deep bg-cloud hover:bg-sky2-50 transition"
              style={{ border: '1px dashed var(--sky2-300)' }}
            >{t('me.newProject')}</button>
            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived((v) => !v)}
                className="text-[11.5px] text-ink-500 hover:text-skype-deep transition italic font-display"
              >
                {showArchived ? t('me.hideArchived') : t('me.showArchivedCount', { n: archivedCount })}
              </button>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

function PreferencesTab() {
  const t = useT()
  const prefs = usePrefs((s) => s.prefs)
  const setPref = usePrefs((s) => s.setPref)
  const devtoolsEnabled = useDevtools((s) => s.enabled)
  const devtoolsCanEnable = useDevtools((s) => s.canEnable)
  const devtoolsLocal = useDevtools((s) => s.localDev)
  const setDevMode = useDevtools((s) => s.setDevMode)
  const loadDevtools = useDevtools((s) => s.load)
  const get = (k: string, fallback: boolean) => (prefs[k] === undefined ? fallback : Boolean(prefs[k]))

  useEffect(() => {
    void loadDevtools()
  }, [loadDevtools])

  return (
    <div className="space-y-6">
      {PREF_GROUPS.map((g) => (
        <Section key={g.title} title={`↳ ${t(g.title)}`}>
          <div className="bg-cloud rounded-[14px] divide-y divide-ink-100"
            style={{ border: '1px solid var(--ink-100)' }}>
            {g.items.map((it, i) => {
              const on = get(it.key, it.default)
              return (
                <div key={i} className="flex items-center gap-4 p-4 cursor-pointer" onClick={() => setPref(it.key, !on)}>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-[13px] text-ink-900">{t(it.lbl)}</div>
                    <div className="font-display italic font-normal text-[11.5px] text-ink-500 mt-0.5">{t(it.sub)}</div>
                  </div>
                  <span className={cn('w-9 h-5 rounded-full relative shrink-0 transition-colors', on ? 'bg-skype' : 'bg-ink-200')}>
                    <span className={cn('absolute w-4 h-4 bg-white rounded-full top-0.5 transition-all', on ? 'left-[18px]' : 'left-0.5')}
                      style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
                  </span>
                </div>
              )
            })}
          </div>
        </Section>
      ))}
      <LanguageSection />
      <AppearanceSection />
      <SkypeSoundSection />
      {devtoolsCanEnable && (
        <Section title={`↳ ${t('me.prefs.developer')}`}>
          <Checkbox
            checked={devtoolsEnabled}
            disabled={devtoolsLocal}
            onCheckedChange={(next) => { void setDevMode(next) }}
            label={t('me.prefs.developerMode')}
            description={devtoolsLocal
              ? t('me.prefs.developerModeLocal')
              : t('me.prefs.developerModeSub')}
          />
        </Section>
      )}
    </div>
  )
}

function LanguageSection() {
  const t = useT()
  return (
    <Section title={`↳ ${t('me.prefs.languageSection')}`}>
      <div className="bg-cloud rounded-[14px] p-4 flex items-center gap-4"
        style={{ border: '1px solid var(--ink-100)' }}>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[13px] text-ink-900">{t('common.language')}</div>
          <div className="font-display italic font-normal text-[11.5px] text-ink-500 mt-0.5">
            {t('common.languageSub')}
          </div>
        </div>
        <LanguagePicker className="w-[180px] shrink-0" />
      </div>
    </Section>
  )
}

function AppearanceSection() {
  const t = useT()
  return (
    <Section title={`↳ ${t('me.prefs.appearanceSection')}`}>
      <div className="bg-cloud rounded-[14px] p-4 flex items-center gap-4"
        style={{ border: '1px solid var(--ink-100)' }}>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[13px] text-ink-900">{t('common.appearance')}</div>
          <div className="font-display italic font-normal text-[11.5px] text-ink-500 mt-0.5">
            {t('common.appearanceSub')}
          </div>
        </div>
        <AppearancePicker className="w-[180px] shrink-0" />
      </div>
    </Section>
  )
}

function SkypeSoundSection() {
  // Local-only toggle — see stores/sound.ts for why this isn't synced
  // through the server preferences store. Default is muted; users opt
  // in if they want the classic (clap) / (drum) chimes.
  const t = useT()
  const muted = useSoundStore((s) => s.muted)
  const setMuted = useSoundStore((s) => s.setMuted)
  const on = !muted
  return (
    <Section title={`↳ ${t('me.prefs.skypeSection')}`}>
      <div className="bg-cloud rounded-[14px]"
        style={{ border: '1px solid var(--ink-100)' }}>
        <div className="flex items-center gap-4 p-4 cursor-pointer" onClick={() => setMuted(on)}>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[13px] text-ink-900">{t('me.prefs.skypeSounds')}</div>
            <div className="font-display italic font-normal text-[11.5px] text-ink-500 mt-0.5">
              {t('me.prefs.skypeSoundsSub')}
            </div>
          </div>
          <span className={cn('w-9 h-5 rounded-full relative shrink-0 transition-colors', on ? 'bg-skype' : 'bg-ink-200')}>
            <span className={cn('absolute w-4 h-4 bg-white rounded-full top-0.5 transition-all', on ? 'left-[18px]' : 'left-0.5')}
              style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
          </span>
        </div>
      </div>
    </Section>
  )
}

// Brand and engine names stay in English in every locale. The values
// below are display labels surfaced to users when we list computers —
// products keep their own casing.
const ENGINE_LABEL: Record<string, string> = { managed: 'Cumora', claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build', cursor: 'Cursor' }
const KIND_ICON: Record<string, string> = { cloud: '☁', local: '💻', vps: '🖥' }
const STATUS_COLOR: Record<string, string> = { online: '#3BB273', busy: '#E6A23C', offline: 'var(--ink-300)' }

function ComputersTab() {
  const t = useT()
  const byId = useComputers((s) => s.byId)
  const loaded = useComputers((s) => s.loaded)
  const participants = useParticipants((s) => s.byId)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Engine for a NEWLY added computer's starter/assigned agents. Claude is the
  // default (no flag → daemon auto-detects); every other pick is named
  // explicitly, or the daemon auto-detects and engines[0] silently wins.
  const [engine, setEngine] = useState<'claude' | 'codex' | 'grok' | 'cursor'>('claude')
  // Default on: install the always-on service (auto-start/restart/update).
  // --install-service is macOS/Linux only (daemon throws on Windows) → off + hidden there.
  const [asService, setAsService] = useState(!isWindows)
  // Per-computer re-pair (reconnect) command, keyed by computer id.
  const [repairFor, setRepairFor] = useState<string | null>(null)
  const [repairCode, setRepairCode] = useState<string | null>(null)
  const [repairCopied, setRepairCopied] = useState(false)

  useEffect(() => { void useComputers.getState().refresh() }, [])
  useEffect(() => { if (!repairCopied) return; const id = window.setTimeout(() => setRepairCopied(false), 1600); return () => window.clearTimeout(id) }, [repairCopied])

  async function toggleRepair(id: string) {
    if (repairFor === id) { setRepairFor(null); setRepairCode(null); return }
    setRepairFor(id); setRepairCode(null)
    try { setRepairCode((await api.repairComputer(id)).code) }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); setRepairFor(null) }
  }
  useEffect(() => { if (!copied) return; const id = window.setTimeout(() => setCopied(false), 1600); return () => window.clearTimeout(id) }, [copied])

  function copyCommand() {
    void navigator.clipboard?.writeText(pairCommand)
    setCopied(true)
  }

  const origin = getPairingServerOrigin()
  const serverFlag = origin ? ` --server ${origin}` : ''
  const engineFlag = engine === 'claude' ? '' : ` --engine ${engine}`
  const pairCommand = code ? `npx cumora@latest agent computer --pair ${code}${serverFlag}${engineFlag}${asService ? ' --install-service' : ''}` : ''
  const list = Object.values(byId).sort((a, b) =>
    (a.kind === 'cloud' ? 0 : 1) - (b.kind === 'cloud' ? 0 : 1) || a.name.localeCompare(b.name))

  function agentCount(computerId: string, isCloud: boolean): number {
    return Object.values(participants).filter((p) =>
      p.kind === 'agent' && !p.departedAt &&
      (p.computerId === computerId || (isCloud && !p.computerId))).length
  }

  // Clicking "Add a computer" just mints a pairing token and shows the command.
  // The computer itself is created server-side only when the daemon pairs and
  // reports the machine's real hostname — so no placeholder row, and it shows
  // up here (named after the machine) once paired, via the WS status event.
  async function addComputer() {
    setErr(null); setBusy(true)
    try {
      const res = await api.requestPairingCode()
      setCode(res.code)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  async function remove(id: string, label: string) {
    if (!confirm(t('me.removeConfirm', { label }))) return
    try {
      await api.deleteComputer(id)
      await useComputers.getState().refresh()
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="space-y-6">
      <Section title={t('me.sectionComputers')}>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static copy from the locale bundle, not user input */}
        <p className="text-[13px] text-ink-500 mb-4 max-w-[640px]" dangerouslySetInnerHTML={{ __html: t('me.computersIntro') }} />

        {!loaded && <div className="text-[13px] text-ink-400">{t('common.loading')}</div>}

        <div className="grid gap-3">
          {list.map((c) => {
            const n = agentCount(c.id, c.kind === 'cloud')
            const repairable = c.kind !== 'cloud'
            const expanded = repairFor === c.id
            const repairCmd = repairCode ? `npx cumora@latest agent computer --pair ${repairCode}${serverFlag}` : ''
            return (
              <div key={c.id} className="bg-cloud rounded-[14px]" style={{ border: '1px solid var(--ink-100)' }}>
                <div
                  className={cn('p-4 flex items-center gap-4 rounded-[14px]', repairable && 'cursor-pointer hover:bg-sky-50/50')}
                  onClick={repairable ? () => void toggleRepair(c.id) : undefined}>
                  <div className="text-[22px] w-8 text-center">{KIND_ICON[c.kind] ?? '🖥'}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-display font-medium text-[16px] text-ink-900">{c.name}</span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-500">
                        <span className="w-2 h-2 rounded-full" style={{ background: STATUS_COLOR[c.status] ?? 'var(--ink-300)' }} />
                        {c.status}
                      </span>
                      {c.daemonOutdated && (
                        <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded-full"
                          style={{ background: 'rgba(244,183,64,0.18)', color: 'var(--gold-deep)' }}
                          title={c.latestDaemonVersion ? t('me.updateToVersion', { version: c.latestDaemonVersion }) : t('me.updateAvailableTitle')}>
                          ↑ {t('me.updateAvailableShort')}{c.daemonVersion ? ` · ${t('me.daemonVersion', { version: c.daemonVersion })}` : ''}
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] text-ink-500 mt-0.5">
                      {c.availableEngines.map((e) => ENGINE_LABEL[e] ?? e).join(', ') || '—'}
                      {' · '}{n === 1 ? t('me.agentsCountOne', { n }) : t('me.agentsCountOther', { n })}
                      {repairable && c.daemonVersion && (
                        <>{' · '}<span className="font-mono text-[11px] text-ink-400">{t('me.daemonVersion', { version: c.daemonVersion })}</span></>
                      )}
                    </div>
                  </div>
                  {repairable && (
                    <>
                      <span className="text-[12px] font-semibold text-skype-deep">{expanded ? t('me.hideAction') : t('me.reconnect')}</span>
                      <button onClick={(e) => { e.stopPropagation(); void remove(c.id, c.name) }}
                        className="text-[12px] font-semibold text-coral-deep hover:underline px-2 py-1">
                        {t('me.remove')}
                      </button>
                    </>
                  )}
                </div>
                {expanded && (
                  <div className="px-4 pb-4 pt-3 border-t border-ink-100">
                    <div className="text-[12px] text-ink-500 mb-2 italic font-display">
                      {t('me.repairHint', { name: c.name })}
                    </div>
                    {!repairCode ? (
                      <div className="text-[12px] text-ink-400">{t('me.computersGenerating')}</div>
                    ) : (
                      <>
                        <pre className="bg-ink-900 text-cloud rounded-[10px] p-3 text-[12px] overflow-x-auto whitespace-pre-wrap break-all font-mono select-all">{repairCmd}</pre>
                        <button onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(repairCmd); setRepairCopied(true) }}
                          className="mt-2 inline-flex items-center justify-center min-w-[120px] text-[12px] font-semibold px-3 py-1.5 rounded-[9px] text-white transition-colors duration-200"
                          style={{ background: repairCopied ? '#3BB273' : 'var(--skype)' }}>
                          {repairCopied ? t('me.copied') : t('me.copyCommand')}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {code ? (
          <div className="mt-4 bg-sky-50 rounded-[14px] p-4" style={{ border: '1px solid var(--sky-100)' }}>
            <div className="text-[13px] font-semibold text-ink-900 mb-1">
              {t('me.runOnHost')}
            </div>
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static copy from the locale bundle, not user input */}
            <div className="text-[11.5px] text-ink-500 mb-2.5 italic font-display" dangerouslySetInnerHTML={{ __html: t('me.engineRequired') }} />
            <div className="flex items-center gap-2.5 mb-2.5">
              <span className="text-[12px] text-ink-500">{t('me.engineLabel')}</span>
              <div className="inline-flex rounded-[9px] p-0.5" style={{ background: 'var(--ink-100)' }}>
                {([['claude', 'Claude Code'], ['codex', 'Codex'], ['grok', 'Grok Build'], ['cursor', 'Cursor']] as const).map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setEngine(id)}
                    className="px-3 py-1 rounded-[7px] text-[12px] font-semibold transition-colors duration-150"
                    style={engine === id
                      ? { background: 'var(--paper)', color: 'var(--ink-900)', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' }
                      : { color: 'var(--ink-500)' }}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-[11px] text-ink-400">{t('me.engineDefaultHint')}</span>
            </div>
            {isWindows ? (
              <div className="mb-2.5 text-[12px] text-ink-600">
                {t('me.keepTerminalOpen')}
                <span className="text-ink-400"> — {t('me.bgServiceUnsupported')}</span>
              </div>
            ) : (
              <label className="flex items-start gap-2 mb-2.5 cursor-pointer select-none">
                <input type="checkbox" checked={asService} onChange={(e) => setAsService(e.target.checked)} className="mt-[3px]" />
                <span className="text-[12px] text-ink-600">
                  {t('me.keepInBackground')} <span className="text-ink-400">— {t('me.keepInBackgroundDetail')}</span>
                </span>
              </label>
            )}
            <pre className="bg-ink-900 text-cloud rounded-[10px] p-3 text-[12px] overflow-x-auto whitespace-pre-wrap break-all font-mono select-all">{pairCommand}</pre>
            <div className="flex gap-2 mt-3">
              <button onClick={copyCommand} aria-live="polite"
                className="inline-flex items-center justify-center gap-1.5 min-w-[128px] text-[12px] font-semibold px-3 py-1.5 rounded-[9px] text-white transition-colors duration-200"
                style={{ background: copied ? '#3BB273' : 'var(--skype)' }}>
                {copied ? (
                  <>
                    <svg key="ck" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                      style={{ animation: 'cp-pop 0.32s cubic-bezier(.36,1.6,.4,1)' }}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span style={{ animation: 'cp-fade 0.2s ease' }}>{t('me.copiedShort')}</span>
                  </>
                ) : t('me.copyCommand')}
              </button>
              <button onClick={() => setCode(null)}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-[9px] border border-ink-100 text-ink-600">{t('me.done')}</button>
            </div>
            <style>{`
              @keyframes cp-pop { 0% { transform: scale(0.2); opacity: 0 } 55% { transform: scale(1.3) } 100% { transform: scale(1); opacity: 1 } }
              @keyframes cp-fade { from { opacity: 0; transform: translateX(-2px) } to { opacity: 1; transform: none } }
            `}</style>
          </div>
        ) : (
          <>
            {err && <div className="mt-4 text-[12px] text-coral-deep bg-coral-soft rounded-[8px] p-2">{err}</div>}
            <button onClick={addComputer} disabled={busy}
              className="mt-4 px-4 py-2 rounded-[10px] bg-skype text-white text-[13px] font-semibold disabled:opacity-50">
              {busy ? t('me.computersGenerating') : t('me.addComputer')}
            </button>
          </>
        )}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[10.5px] font-extrabold text-skype tracking-[0.14em] uppercase mb-3">{title}</h4>
      {children}
    </div>
  )
}

/** Elegant, self-clearing "your daemon is behind" banner. Shows the moment any
 *  paired computer reports an outdated `cumora` daemon, and disappears on its own
 *  once the daemon restarts onto the latest (the next heartbeat clears the flag).
 *  Warm gold (an invitation to update), not alarm red. One-click copy. */
function DaemonUpgradeBanner({ onJump }: { onJump: () => void }) {
  const t = useT()
  const byId = useComputers((s) => s.byId)
  const [copied, setCopied] = useState(false)
  const outdated = Object.values(byId).filter((c) => c.daemonOutdated)
  if (outdated.length === 0) return null

  const latest = outdated.map((c) => c.latestDaemonVersion).find(Boolean) ?? null
  const one = outdated.length === 1 ? outdated[0] : null
  // Run-mode-aware instructions. A supervised daemon (--install-service) is
  // restarted through its launchd/systemd wrapper; a manually-run foreground
  // daemon has no wrapper — the user must Ctrl-C it and re-run the command.
  // Unknown (old daemon not reporting the mode yet) gets the service command,
  // which itself prints install-service guidance when no service exists.
  const manual = outdated.filter((c) => c.daemonSupervised === false)
  const allManual = manual.length === outdated.length
  const cmd = allManual ? 'npx cumora@latest agent computer' : 'npx cumora@latest agent computer --restart'
  const copy = () => { void navigator.clipboard?.writeText(cmd); setCopied(true); window.setTimeout(() => setCopied(false), 1600) }

  return (
    <div className="relative overflow-hidden rounded-[16px] mb-6"
      style={{ border: '1px solid rgba(244,183,64,0.45)', background: 'linear-gradient(135deg, rgba(244,183,64,0.15), rgba(244,183,64,0.035) 70%)' }}>
      <div className="p-4 flex items-start gap-4">
        <div className="shrink-0 mt-0.5 w-9 h-9 rounded-full flex items-center justify-center text-[17px] font-bold"
          style={{ background: 'rgba(244,183,64,0.22)', color: 'var(--gold-deep)' }}>↑</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="font-display font-semibold text-[15px] text-ink-900">{t('me.updateAvailableTitle')}</span>
            {latest && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-mono">
                {one?.daemonVersion && (
                  <span className="px-1.5 py-0.5 rounded-full" style={{ background: 'var(--ink-100)', color: 'var(--ink-500)' }}>{t('me.daemonVersion', { version: one.daemonVersion })}</span>
                )}
                <span className="text-ink-300">→</span>
                <span className="px-1.5 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(244,183,64,0.30)', color: 'var(--gold-deep)' }}>{t('me.daemonVersion', { version: latest })}</span>
              </span>
            )}
          </div>
          <div className="text-[12.5px] text-ink-600 mt-1 leading-relaxed">
            {one ? (
              <><strong className="text-ink-900 font-medium">{one.name}</strong>{' '}{t('me.daemonOutdatedOne')}</>
            ) : (
              <><strong className="text-ink-900 font-medium">{outdated.length}</strong> {t('me.daemonOutdatedMany', { n: outdated.length, names: outdated.map((c) => c.name).join(', ') })}</>
            )}
            {allManual ? (
              <>{' '}{one ? t('me.daemonManualHelp') : t('me.daemonManualHelpPlural')}</>
            ) : (
              <>
                {' '}{one ? t('me.daemonAutoHelp') : t('me.daemonAutoHelpPlural')}
                {manual.length > 0 && (
                  <>{' '}({manual.map((c) => c.name).join(', ')} {manual.length === 1 ? t('me.daemonManualInfix') : t('me.daemonManualInfixPlural')} {t('me.daemonManualRun')} — Ctrl-C and re-run there instead.)</>
                )}
              </>
            )}
          </div>
          <div className="mt-2.5 flex items-stretch gap-2 max-w-[580px]">
            <code className="flex-1 bg-ink-900 text-cloud rounded-[10px] px-3 py-2 text-[12px] font-mono overflow-x-auto whitespace-nowrap select-all flex items-center">{cmd}</code>
            <button onClick={copy}
              className="shrink-0 inline-flex items-center justify-center min-w-[82px] text-[12px] font-semibold px-3 rounded-[10px] text-white transition-colors duration-200"
              style={{ background: copied ? 'var(--avail)' : 'var(--gold-deep)' }}>
              {copied ? t('me.copiedShort') : t('me.copy')}
            </button>
          </div>
          <button onClick={onJump} className="mt-2 text-[11.5px] font-semibold text-gold-deep hover:underline" style={{ color: 'var(--gold-deep)' }}>
            {t('me.manageComputers')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function MeView() {
  const t = useT()
  const [tab, setTab] = useState<Tab>('profile')
  const hasOutdated = useComputers((s) => Object.values(s.byId).some((c) => c.daemonOutdated))
  useEffect(() => { void useComputers.getState().refresh() }, [])

  return (
    <main className="overflow-y-auto p-8 pt-6"
      style={{ background: 'linear-gradient(180deg, transparent, var(--paper))' }}>
      <div className="max-w-[1100px] mx-auto">
        <div className="mb-6">
          <h1 className="font-display font-medium text-[36px] tracking-tight text-ink-900 mb-1" style={{ letterSpacing: '-0.025em' }}>
            {t('me.headline')} <em className="italic text-coral-deep" style={{ fontStyle: 'italic', fontWeight: 400 }}>{t('me.headlineEm')}</em>
          </h1>
          <div className="font-display italic font-normal text-[15px] text-ink-500">
            {t('me.subtitle')}
          </div>
        </div>

        <DaemonUpgradeBanner onJump={() => setTab('computers')} />

        <div className="flex gap-1 mb-7 border-b border-ink-100">
          {tabs.map((tabDef, i) => (
            <button
              key={tabDef.key}
              onClick={() => setTab(tabDef.key)}
              className={cn(
                'py-2.5 text-[13px] font-semibold border-b-2 transition -mb-px inline-flex items-center gap-1.5',
                i === 0 ? 'pl-0 pr-5' : 'px-5',
                tab === tabDef.key ? 'border-skype text-skype-deep' : 'border-transparent text-ink-500 hover:text-ink-700',
              )}>
              {t(tabDef.label)}
              {tabDef.key === 'computers' && hasOutdated && (
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--gold-deep)' }} title={t('me.daemonNeedsUpdate')} />
              )}
            </button>
          ))}
        </div>

        {tab === 'profile' && <ProfileTab />}
        {tab === 'usage' && <UsageTab />}
        {tab === 'computers' && <ComputersTab />}
        {tab === 'projects' && <ProjectsTab />}
        {tab === 'trust' && <TrustTab />}
        {tab === 'preferences' && <PreferencesTab />}
      </div>
    </main>
  )
}
