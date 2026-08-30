/**
 * UpdaterDialog — UI shell for the auto-update flow.
 *
 * Two surfaces talk to the same `useUpdater` hook:
 *   • A subtle <UpdateBanner /> that slides in across the title bar
 *     when an update is detected. Click → opens this dialog.
 *   • This <UpdaterDialog /> — the full picture: from→to version, the
 *     LLM-generated changelog from the GitHub Release body, a
 *     download progress bar, and the "Restart" CTA.
 *
 * State machine (matches electron-updater + our broadcast contract):
 *   idle → checking → update-available → downloading → update-downloaded
 *   any → error
 *   unsupported (terminal, dev / PWA mode)
 *
 * Inspired by alma's UpdaterDialog but rebuilt for cumora's brand —
 * skype-blue palette, paper backgrounds, Manrope display font.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppUpdateInfo, AutoUpdateStatus, UpdateReleasePayload,
} from '@/lib/runtime'
import { useT } from '@/lib/i18n'

/* ============== Shared hook ============== */

interface UpdaterState {
  ready: boolean
  appInfo: AppUpdateInfo | null
  status: AutoUpdateStatus
  releaseInfo: UpdateReleasePayload | null
}

/** Single source of truth for the autoupdate surface. Subscribes to
 *  the Electron bridge and re-renders on every state change. Returns a
 *  no-op shape in non-Electron contexts so the UI can render in
 *  browser/dev without crashing. */
export function useUpdater(): UpdaterState & {
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
} {
  const [appInfo, setAppInfo] = useState<AppUpdateInfo | null>(null)
  const [status, setStatus] = useState<AutoUpdateStatus>({ status: 'idle' })
  const [releaseInfo, setReleaseInfo] = useState<UpdateReleasePayload | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.cumora?.update : undefined
    if (!bridge) {
      setStatus({ status: 'unsupported', detail: 'browser mode' })
      setReady(true)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const info = await bridge.getAppInfo()
        if (cancelled) return
        setAppInfo(info)
        setStatus(info.autoUpdateStatus)
        const release = await bridge.getInfo()
        if (cancelled) return
        if (release) setReleaseInfo(release)
      } catch (e) {
        if (!cancelled) {
          setStatus({ status: 'error', detail: e instanceof Error ? e.message : String(e) })
        }
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    const off = bridge.onStatus((payload) => {
      setStatus(payload)
      // Re-pull release info when we transition into "available" or
      // "downloaded" so the changelog hydrates.
      if (payload.status === 'update-available' || payload.status === 'update-downloaded') {
        void bridge.getInfo().then((r) => r && setReleaseInfo(r))
      }
    })
    return () => { cancelled = true; off?.() }
  }, [])

  const check = useCallback(async () => {
    const bridge = window.cumora?.update
    if (!bridge) return
    await bridge.check()
  }, [])
  const download = useCallback(async () => {
    const bridge = window.cumora?.update
    if (!bridge) return
    await bridge.download()
  }, [])
  const install = useCallback(async () => {
    const bridge = window.cumora?.update
    if (!bridge) return
    await bridge.install()
  }, [])

  return { ready, appInfo, status, releaseInfo, check, download, install }
}

/* ============== Banner ============== */

interface BannerProps {
  /** Force the banner open (e.g. from a dev shortcut). */
  forceOpen?: boolean
  /** Open the full dialog. */
  onOpen: () => void
}

/** Slim status banner that hovers above the chat when an update is
 *  available or being downloaded. Dismissable for this session. */
export function UpdateBanner({ forceOpen, onOpen }: BannerProps) {
  const t = useT()
  const { status, releaseInfo } = useUpdater()
  const [dismissed, setDismissed] = useState(false)

  const visible = forceOpen || (!dismissed && (
    status.status === 'update-available'
    || status.status === 'downloading'
    || status.status === 'update-downloaded'
  ))
  if (!visible) return null

  const isDownloaded = status.status === 'update-downloaded'
  const isDownloading = status.status === 'downloading'
  const version = status.version ?? releaseInfo?.version ?? ''

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-40"
      style={{
        // Push below the macOS traffic-light row. With titleBarStyle:
        // 'hidden' the top of the window is a drag region by default —
        // any click within the first ~28px got absorbed as a window
        // drag, which is why the Update button "wouldn't click". We
        // both move the banner clear of that region AND mark its
        // descendants no-drag so the click hits the React handler.
        top: 'calc(env(safe-area-inset-top, 0px) + 44px)',
        maxWidth: 'calc(100% - 32px)',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <div
        className="flex items-center gap-3 rounded-[12px] px-4 py-2 animate-rise"
        style={{
          // animate-rise drives `transform` during the keyframe — keeping
          // the rise on this inner div leaves the outer -translate-x-1/2
          // intact instead of letting the keyframe reset it mid-animation
          // (which read as a tiny snap-left after the banner appeared).
          background: 'linear-gradient(135deg, var(--sky-50), var(--cloud))',
          border: '1px solid var(--sky2-300)',
          boxShadow: '0 12px 28px -8px rgba(0, 80, 140, 0.18), 0 0 0 1px rgba(0, 80, 140, 0.06)',
        }}
      >
      <span
        className="w-7 h-7 rounded-full grid place-items-center text-white text-[14px] font-bold shrink-0"
        style={{ background: 'var(--skype)' }}
      >
        {isDownloaded ? '✓' : '↑'}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-ink-900 truncate">
          {isDownloaded ? t('updater.bannerUpdateReady') : isDownloading ? t('updater.bannerUpdating') : t('updater.bannerNewAvailable')}
          {version && <span className="ml-1.5 text-ink-500 font-normal">v{version}</span>}
        </div>
        {isDownloading && status.percent !== undefined && (
          <div className="text-[11px] text-ink-500 font-display italic mt-0.5">
            {status.percent.toFixed(0)}% · {fmtBytes(status.transferred ?? 0)} / {fmtBytes(status.total ?? 0)}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="px-3 py-1.5 rounded-[8px] text-[12px] font-semibold text-white transition shrink-0"
        style={{ background: 'var(--skype)' }}
      >
        {isDownloaded ? t('updater.bannerRestart') : isDownloading ? t('updater.bannerView') : t('updater.bannerUpdate')}
      </button>
      {!isDownloading && (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="w-6 h-6 rounded-[6px] grid place-items-center text-ink-400 hover:text-ink-700 hover:bg-cloud transition text-[14px] shrink-0"
          aria-label={t('updater.bannerDismiss')}
        >×</button>
      )}
      </div>
    </div>
  )
}

/* ============== Dialog ============== */

interface DialogProps {
  open: boolean
  onClose: () => void
}

export function UpdaterDialog({ open, onClose }: DialogProps) {
  const t = useT()
  const { appInfo, status, releaseInfo, check, download, install } = useUpdater()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const changelog = useMemo(
    () => releaseInfo?.releaseNotes ? formatChangelog(releaseInfo.releaseNotes) : null,
    [releaseInfo?.releaseNotes],
  )

  if (!open) return null

  const kind = status.status
  const currentVersion = appInfo?.version ?? '—'
  const nextVersion = status.version ?? releaseInfo?.version ?? '—'
  const isUnsupported = kind === 'unsupported' || appInfo?.autoUpdateSupported === false

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{
        background: kind === 'downloading' ? 'rgba(15, 30, 50, 0.34)' : 'rgba(15, 30, 50, 0.48)',
      }}
      onClick={onClose}
    >
      <div
        className="bg-paper rounded-[18px] shadow-pop w-full max-w-[460px] overflow-hidden flex flex-col"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-ink-100">
          <h2 className="font-display font-medium text-[18px] tracking-tight text-ink-900">
            {t('updater.title')}
          </h2>
          <div className="mt-1 text-[12.5px] text-ink-500 italic font-display">
            {kind === 'idle' && t('updater.latestVersion')}
            {kind === 'checking' && t('updater.checkingUpdates')}
            {kind === 'update-not-available' && t('updater.latestVersion')}
            {kind === 'update-available' && t('updater.newVersionReady')}
            {kind === 'downloading' && t('updater.downloadingUpdate')}
            {kind === 'update-downloaded' && t('updater.updateDownloaded')}
            {kind === 'error' && t('updater.checkFailed')}
            {isUnsupported && t('updater.unsupported')}
          </div>
        </div>

        <div className="px-6 py-5 flex flex-col gap-4">
          {/* Version row */}
          <div className="flex items-center gap-3 font-mono text-[13px]">
            <span className="text-ink-500">v{currentVersion}</span>
            {(kind === 'update-available' || kind === 'downloading' || kind === 'update-downloaded') && (
              <>
                <span className="text-ink-300">→</span>
                <span className="text-ink-900 font-semibold">v{nextVersion}</span>
              </>
            )}
          </div>

          {/* Changelog */}
          {changelog && (
            <div>
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-ink-500 mb-2">
                {t('updater.whatsNew')}
              </div>
              <div
                className="text-[13px] text-ink-700 max-h-44 overflow-y-auto leading-relaxed rounded-[8px] p-3"
                style={{ background: 'var(--cloud)', border: '1px solid var(--ink-100)' }}
              >
                {changelog}
              </div>
            </div>
          )}

          {/* Progress */}
          {kind === 'downloading' && (
            <div>
              <div className="flex justify-between text-[11.5px] text-ink-500 mb-1.5 font-display italic">
                <span>{t('updater.downloadingLabel')}</span>
                <span className="font-mono text-ink-700">
                  {(status.percent ?? 0).toFixed(0)}% · {fmtBytes(status.transferred ?? 0)} / {fmtBytes(status.total ?? 0)}
                </span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--ink-100)' }}>
                <div
                  className="h-full transition-all duration-200"
                  style={{
                    // sky2-glow exists in tailwind config but isn't
                    // emitted as a CSS variable — fall back to the
                    // canonical skype palette which is in globals.css.
                    width: `${status.percent ?? 0}%`,
                    background: 'linear-gradient(90deg, var(--skype-deep), var(--skype))',
                  }}
                />
              </div>
            </div>
          )}

          {/* Downloaded confirmation */}
          {kind === 'update-downloaded' && (
            <div
              className="flex items-center gap-2 rounded-[8px] px-3 py-2.5 text-[13px]"
              style={{ background: 'rgba(110, 197, 106, 0.08)', color: '#2d8c72', border: '1px solid rgba(110, 197, 106, 0.25)' }}
            >
              <span className="font-bold">✓</span>
              <span>{t('updater.readyToInstall')}</span>
            </div>
          )}

          {/* Error */}
          {kind === 'error' && status.detail && (
            <div
              className="flex items-start gap-2 rounded-[8px] px-3 py-2.5 text-[12.5px] text-coral-deep"
              style={{ background: 'var(--coral-soft)' }}
            >
              <span className="font-bold mt-px">!</span>
              <span className="font-mono break-words">{status.detail}</span>
            </div>
          )}
        </div>

        <div className="px-6 py-4 flex items-center gap-2 border-t border-ink-100 bg-cloud">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-ink-700 hover:bg-paper transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >
            {kind === 'update-downloaded' ? t('updater.laterAction') : t('updater.closeAction')}
          </button>
          <div className="flex-1" />

          {(kind === 'idle' || kind === 'update-not-available' || kind === 'error') && !isUnsupported && (
            <button
              type="button"
              onClick={() => void check()}
              className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-white transition"
              style={{ background: 'var(--skype)' }}
            >{t('updater.checkAgain')}</button>
          )}
          {kind === 'checking' && (
            <button
              type="button"
              disabled
              className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-white opacity-60"
              style={{ background: 'var(--skype)' }}
            >{t('updater.checkingEllipsis')}</button>
          )}
          {kind === 'update-available' && (
            <button
              type="button"
              onClick={() => void download()}
              className="px-5 py-2 rounded-[9px] text-[12.5px] font-semibold text-white transition"
              style={{
                background: 'var(--skype)',
                boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)',
              }}
            >{t('updater.download')}</button>
          )}
          {kind === 'downloading' && (
            <button
              type="button"
              disabled
              className="px-5 py-2 rounded-[9px] text-[12.5px] font-semibold text-white opacity-60"
              style={{ background: 'var(--skype)' }}
            >{t('updater.downloadingEllipsis')}</button>
          )}
          {kind === 'update-downloaded' && (
            <button
              type="button"
              onClick={() => void install()}
              className="px-5 py-2 rounded-[9px] text-[12.5px] font-semibold text-white transition"
              style={{
                background: 'var(--skype)',
                boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)',
              }}
            >{t('updater.restartNow')}</button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ============== Helpers ============== */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Very light markdown rendering for release notes — we don't need a
 *  full md parser here, just headings → bold and `- item` → bullet. */
function formatChangelog(notes: string): React.ReactNode {
  const lines = notes.split('\n')
  const out: React.ReactNode[] = []
  let key = 0
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { out.push(<div key={key++} className="h-1.5" />); continue }
    if (/^#{1,6}\s+/.test(line)) {
      out.push(
        <div key={key++} className="font-semibold text-ink-900 mt-2 first:mt-0">
          {line.replace(/^#{1,6}\s+/, '')}
        </div>,
      )
      continue
    }
    if (/^[-*•]\s+/.test(line)) {
      out.push(
        <div key={key++} className="flex gap-2">
          <span className="text-ink-300">•</span>
          <span className="flex-1">{line.replace(/^[-*•]\s+/, '')}</span>
        </div>,
      )
      continue
    }
    out.push(<div key={key++}>{line}</div>)
  }
  return out
}
