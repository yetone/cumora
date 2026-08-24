/* eslint-env node */
const { contextBridge, ipcRenderer } = require('electron')

/** Renderer-side surface exposed to the React app. */
contextBridge.exposeInMainWorld('cumora', {
  isElectron: true,
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },

  /**
   * Native OS-level focus state of the MAIN window. Reliable substitute
   * for `document.hasFocus()`, which can mis-report on Electron/macOS.
   */
  app: {
    isFocused: () => ipcRenderer.invoke('app:is-focused'),
    onFocusChange: (handler) => {
      const wrapped = (_evt, focused) => handler(!!focused)
      ipcRenderer.on('app:focus-state', wrapped)
      return () => ipcRenderer.removeListener('app:focus-state', wrapped)
    },
  },

  /** Native Dock affordances. macOS-only in main; no-op elsewhere. */
  dock: {
    setUnreadDot: (visible) => ipcRenderer.send('dock:set-unread-dot', !!visible),
  },

  /**
   * Notification window plumbing. Two consumers:
   *  - the MAIN window's React app calls `notify.push(payload)` when a
   *    new message arrives AND the window is unfocused. The Electron
   *    main process forwards it to the dedicated notification
   *    BrowserWindow that lives top-right on the primary display.
   *  - the NOTIFICATION window's React app calls `notify.focusConvo(id)`
   *    when the user clicks a toast — main process focuses the main
   *    window and sends `focus-convo` so the React app selects the
   *    conversation.
   */
  notify: {
    push: (payload) => ipcRenderer.send('notification:push', payload),
    dismiss: (id) => ipcRenderer.send('notification:dismiss', id),
    focusConvo: (conversationId) => ipcRenderer.send('notification:focus-convo', conversationId),
    /** Notification renderer → main: I have mounted, flush queued pushes. */
    ready: () => ipcRenderer.send('notification:ready'),
    /** Notification renderer → main: first toast has painted, show me. */
    painted: () => ipcRenderer.send('notification:painted'),
    /** Notification renderer → main: resize panel to fit content height. */
    setHeight: (h) => ipcRenderer.send('notification:set-height', h),
    /** MAIN window subscribes — fires when notif panel is now on-screen. */
    onVisible: (handler) => {
      const wrapped = () => handler()
      ipcRenderer.on('notification:visible', wrapped)
      return () => ipcRenderer.removeListener('notification:visible', wrapped)
    },
    /** True → window accepts clicks (toast visible); False → destroy. */
    setInteractive: (interactive) => ipcRenderer.send('notification:set-interactive', !!interactive),
    /** Subscribed from the notification window — fires when main forwards a new toast. */
    onPush: (handler) => {
      const wrapped = (_evt, payload) => handler(payload)
      ipcRenderer.on('notification:push', wrapped)
      return () => ipcRenderer.removeListener('notification:push', wrapped)
    },
    /** Subscribed from the MAIN window — fires when notification window asks to focus a conversation. */
    onFocusConvo: (handler) => {
      const wrapped = (_evt, conversationId) => handler(conversationId)
      ipcRenderer.on('notification:focus-convo', wrapped)
      return () => ipcRenderer.removeListener('notification:focus-convo', wrapped)
    },
  },

  /**
   * OAuth loopback plumbing. Sign-in opens the user's system browser
   * via `auth.openExternal(url)`; after the provider redirects through
   * our server to http://127.0.0.1:47823/auth/done, the loopback HTML
   * page POSTs the token to the main process, which IPCs it here.
   * AuthGate subscribes via `onToken` to plant the session.
   */
  auth: {
    openExternal: (url) => ipcRenderer.invoke('auth:open-external', url),
    // Arm a single-use nonce before opening the browser; the renderer threads
    // it through the OAuth return URL so main can verify the inbound token was
    // app-initiated (anti session-fixation).
    arm: () => ipcRenderer.invoke('auth:arm'),
    onToken: (handler) => {
      const wrapped = (_evt, payload) => handler(payload)
      ipcRenderer.on('auth:token', wrapped)
      return () => ipcRenderer.removeListener('auth:token', wrapped)
    },
  },

  /**
   * Appearance preference. Mirrors the renderer's `system | light | dark`
   * so Chromium's `prefers-color-scheme` (and the traffic lights) stay
   * honest. Previously main forced `light` because the UI had no dark
   * palette.
   */
  theme: {
    set: (source) => ipcRenderer.send('theme:set', source),
  },

  /**
   * Auto-update bridge. Mirrors alma's pattern:
   *   - getAppInfo() — current version + autoupdate capability flag
   *   - getStatus()  — last broadcast status (idle / checking / available / downloading / downloaded / error)
   *   - getInfo()    — { version, releaseNotes, releaseDate } for the
   *                    last detected update
   *   - check()      — fire a manual check; returns the resolved result
   *   - download()   — start download (we set autoDownload=false so this is explicit)
   *   - install()    — quit + install (relaunches at new version)
   *   - onStatus()   — subscribe to status broadcasts; returns unsubscribe
   */
  update: {
    getAppInfo: () => ipcRenderer.invoke('update:app-info'),
    getStatus: () => ipcRenderer.invoke('update:status'),
    getInfo: () => ipcRenderer.invoke('update:info'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (handler) => {
      const wrapped = (_evt, payload) => handler(payload)
      ipcRenderer.on('auto-update-status', wrapped)
      return () => ipcRenderer.removeListener('auto-update-status', wrapped)
    },
  },
})
