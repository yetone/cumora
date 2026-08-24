/** Runtime detection — is this Cumora running inside Electron, mobile webview, or browser? */

export interface NotificationPushPayload {
  id: string
  /** Underlying message id — used by the notification renderer to
   *  dedupe identical pushes (e.g. if the WS bus delivers the same
   *  message.new twice during a flaky reconnect). The toast `id`
   *  carries a timestamp suffix so React keys stay unique across
   *  re-pushes, but `messageId` is the actual identity. */
  messageId: string
  conversationId: string
  authorId: string
  authorName: string
  authorAvatarUrl?: string | null
  /** Single uppercase letter used in the avatar fallback when no
   *  portrait URL is available — mirrors the convo-list avatar style. */
  authorInitial?: string
  /** CSS background (color or gradient) for the avatar fallback —
   *  pulled from `participant.avatarBg`. Each agent has a stable color
   *  so the fallback always reads as "Bram's avatar", not a blank disc. */
  authorAvatarBg?: string
  conversationTitle: string
  body: string
  at: number
  /** Conversation-level unread count snapshot at push time. Shown on
   *  the toast only when > 1 — single new messages don't get decorated
   *  with a redundant "1". */
  unreadCount?: number
}

interface CumoraBridge {
  isElectron: boolean
  platform: string
  versions: { chrome: string; electron: string; node: string }
  /** Main-window focus state, sourced from native OS events. */
  app?: {
    isFocused: () => Promise<boolean>
    onFocusChange: (handler: (focused: boolean) => void) => () => void
  }
  /** Native Dock affordances. Currently only meaningful on macOS. */
  dock?: {
    setUnreadDot: (visible: boolean) => void
  }
  notify?: {
    /** Main → notification window: show this toast. */
    push: (p: NotificationPushPayload) => void
    /** Main / notification → notification window: remove a toast id. */
    dismiss: (id: string) => void
    /** Notification → main: bring main window forward + select convo. */
    focusConvo: (conversationId: string) => void
    /** Notification → main: renderer is mounted; flush queued pushes. */
    ready: () => void
    /** Notification → main: first toast painted, OK to show the window. */
    painted: () => void
    /** Notification → main: resize the panel to fit content height. */
    setHeight: (h: number) => void
    /** Main window subscribes — fires when the notif panel becomes
     *  visible. Lets the always-loaded main window play the chime in
     *  sync with the on-screen appearance instead of pre-loading audio
     *  in the just-spawned notification renderer. */
    onVisible: (handler: () => void) => () => void
    /** Notification → main: toggle click-through. True while a toast is on
     *  screen so it can be clicked; false destroys the window so nothing
     *  sits invisibly on top of the desktop. */
    setInteractive: (interactive: boolean) => void
    /** Notification window subscribes — fires on each push from main. */
    onPush: (handler: (p: NotificationPushPayload) => void) => () => void
    /** Main window subscribes — fires when notif window asks to focus a convo. */
    onFocusConvo: (handler: (conversationId: string) => void) => () => void
  }
  /** OAuth loopback bridge. Main process opens the user's system
   *  browser via openExternal(); after the provider chain, our local
   *  loopback HTTP server (port 47823) catches the redirect, the
   *  served HTML page POSTs the parsed fragment to /auth/token, and
   *  onToken fires here so AuthGate can plant the session. */
  auth?: {
    openExternal: (url: string) => Promise<boolean>
    /** Arm a single-use handoff nonce (anti session-fixation). Returns the
     *  nonce to thread through the OAuth return URL. */
    arm?: () => Promise<string>
    onToken: (handler: (payload: { token: string; companyId: string | null }) => void) => () => void
  }
  /** Appearance preference → Electron `nativeTheme.themeSource` so
   *  `prefers-color-scheme` in the renderer matches the user's pick. */
  theme?: {
    set: (source: 'system' | 'light' | 'dark') => void
  }
  /** Auto-update bridge — ported from alma's pattern. Surfaces
   *  electron-updater status to the renderer so the React side can
   *  render the upgrade UI without polling. Unavailable in browser /
   *  PWA mode (only present when `cumora.isElectron`). */
  update?: {
    getAppInfo: () => Promise<AppUpdateInfo>
    getStatus: () => Promise<AutoUpdateStatus>
    getInfo: () => Promise<UpdateReleasePayload | null>
    check: () => Promise<ManualUpdateResult>
    download: () => Promise<{ ok: boolean; error?: string }>
    install: () => Promise<{ ok: boolean }>
    onStatus: (handler: (payload: AutoUpdateStatus) => void) => () => void
  }
}

/** Status broadcast on every state change. `idle` is the initial value;
 *  `unsupported` means the running build can't auto-update at all
 *  (PWA, ad-hoc dev, packaged without a feed). */
export type AutoUpdateKind =
  | 'idle' | 'checking' | 'update-available' | 'update-not-available'
  | 'downloading' | 'update-downloaded' | 'error' | 'unsupported'

export interface AutoUpdateStatus {
  status: AutoUpdateKind
  version?: string
  detail?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  /** True if the manual "Check for updates" button kicked this off. UI
   *  uses this to decide whether to surface a "no update" toast (don't
   *  bother for background checks). */
  triggeredByUser?: boolean
}

export type ManualUpdateResult =
  | { status: 'unsupported'; message?: string }
  | { status: 'update-available'; version?: string }
  | { status: 'update-downloaded'; version?: string }
  | { status: 'update-not-available' }
  | { status: 'error'; message?: string }

export interface AppUpdateInfo {
  name: string
  version: string
  autoUpdateSupported: boolean
  autoUpdateStatus: AutoUpdateStatus
}

export interface UpdateReleasePayload {
  version: string
  releaseNotes: string | null
  releaseDate: string
}

declare global {
  interface Window {
    cumora?: CumoraBridge
  }
}

export const isElectron: boolean = typeof window !== 'undefined' && window.cumora?.isElectron === true

/** True when this renderer is the public web client (e.g. app.cumora.ai).
 *  Cumora is a desktop-only product on the web side — when this is true
 *  we skip the full chat shell and only surface sign-in, waitlist, and a
 *  desktop hand-off. The `?webonly=1` escape exists so localhost dev can
 *  preview the trimmed shell without /etc/hosts trickery. */
export const isWebAppHost: boolean = (() => {
  if (typeof window === 'undefined') return false
  if (isElectron) return false
  if (/^app\./i.test(window.location.hostname)) return true
  if (window.location.search.includes('webonly=1')) return true
  return false
})()

export const platform: string = (typeof window !== 'undefined' && window.cumora?.platform) || (typeof navigator !== 'undefined' ? navigator.platform.toLowerCase() : 'web')

export const isMac = platform === 'darwin' || platform.includes('mac')
// NB: use startsWith, not includes — `'darwin'.includes('win')` is true.
export const isWindows = platform === 'win32' || platform.startsWith('win')

/** macOS native traffic-light width when titleBarStyle is 'hidden' — leave room for them */
export const trafficLightInset = isElectron && isMac ? 84 : 0

/** True when this renderer is the dedicated notification window
 *  (loaded with the `#notifications` hash). The App component branches
 *  on this to render only the toast stack. */
export const isNotificationWindow: boolean =
  typeof window !== 'undefined' && window.location.hash === '#notifications'

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}
declare global {
  interface Window {
    Capacitor?: CapacitorGlobal
  }
}

/** True when running inside a Capacitor-wrapped native shell (iOS / Android).
 *  Electron is a separate path — `isElectron` above. The Capacitor bridge
 *  injects `window.Capacitor` at first paint; the browser build doesn't
 *  ship it. */
export const isCapacitor: boolean =
  typeof window !== 'undefined' && typeof window.Capacitor?.isNativePlatform === 'function'
    ? window.Capacitor.isNativePlatform()
    : false

export const isCapacitorIOS: boolean = isCapacitor && window.Capacitor?.getPlatform?.() === 'ios'

export const isCapacitorAndroid: boolean = isCapacitor && window.Capacitor?.getPlatform?.() === 'android'

/** True inside either native shell (iOS or Android) — both run real push
 *  via @capacitor/push-notifications (APNs on iOS, FCM on Android). */
export const isCapacitorNative: boolean = isCapacitorIOS || isCapacitorAndroid
