/* eslint-env node */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, nativeTheme, screen, ipcMain, globalShortcut, protocol, net } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const autoUpdater = require('./autoUpdater.cjs')

const isDev = !app.isPackaged
const DEV_URL = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5180'

// ============== `app://` scheme — packaged renderer is served from here ==
// Production packaging would otherwise load index.html over `file://`,
// where ANY absolute path (`/logo.png`, `/assets/index-XYZ.js`, the
// favicons in <link>, …) resolves to `file:///foo` — outside the
// asar — and 404s. Vite's `base: './'` trick only fixes the bundled
// imports; hard-coded JSX `src="/logo.png"` stays absolute.
//
// Registering `app://cumora/` as a privileged scheme + serving every
// request out of the packaged `dist/` directory normalises both classes
// of paths: absolute `/foo` and relative `./foo` both end up as
// `app://cumora/<path>` and resolve to `<resources>/dist/<path>`. The
// renderer otherwise can't tell it isn't running over plain http(s).
//
// Why `cumora` as the hostname (not `localhost`): the renderer's Origin
// header gets stamped from this URL on any cross-origin fetch, and the
// API server's CUMORA_CORS_ORIGINS gates the response on that origin.
// Picking a project-specific host keeps the allowlist tight (no
// arbitrary local app gets a CORS pass) and reads more semantically.
//
// `standard: true` makes the scheme behave like http(s) for URL parsing,
// CORS, history.pushState, etc. `secure: true` qualifies it as a secure
// context so the WebCrypto subtle API + service workers (if we ever want
// one) work. `supportFetchAPI: true` enables fetch() against same-scheme
// URLs — the renderer's own JS doesn't need it currently, but leaving it
// on costs nothing and avoids a future foot-gun.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

/** Resolve the on-disk path for an `app://<host>/<request-path>` URL.
 *  Strips leading slashes from the URL path and joins under the packaged
 *  dist directory. Rejects anything that resolves OUTSIDE dist (path
 *  traversal guard). Host is ignored — we accept any so legacy
 *  `app://localhost` URLs that might be sitting in localStorage redirect
 *  history still resolve. */
function appProtocolFile(reqUrl) {
  const u = new URL(reqUrl)
  const distRoot = path.join(__dirname, '..', 'dist')
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  if (!rel || rel === 'index.html') rel = 'index.html'
  const resolved = path.normalize(path.join(distRoot, rel))
  if (!resolved.startsWith(distRoot)) return null
  return resolved
}

/** Persistent main-window geometry. Saved on every resize/move/close and
 *  restored on launch — so users get the size + position they had last,
 *  and first-run gets a sensible non-fullscreen default. */
const WINDOW_STATE_PATH = () => path.join(app.getPath('userData'), 'window-state.json')
const DEFAULT_WINDOW_STATE = { width: 1480, height: 920, fullscreen: false, maximized: false }

function readWindowState() {
  try {
    const raw = fs.readFileSync(WINDOW_STATE_PATH(), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed
  } catch { return null }
}

function writeWindowState(state) {
  try { fs.writeFileSync(WINDOW_STATE_PATH(), JSON.stringify(state)) }
  catch (e) { console.warn('[window-state] save failed', e?.message || e) }
}

/** Returns `{ x, y, width, height }` if the saved rect intersects a
 *  currently-connected display by at least ~80px on each axis, or null
 *  if the saved position is offscreen (monitor disconnected, etc.). */
function visibleRect(saved) {
  if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number'
      || typeof saved.width !== 'number' || typeof saved.height !== 'number') return null
  const r = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
  const displays = screen.getAllDisplays()
  for (const d of displays) {
    const wa = d.workArea
    const interW = Math.min(r.x + r.width, wa.x + wa.width) - Math.max(r.x, wa.x)
    const interH = Math.min(r.y + r.height, wa.y + wa.height) - Math.max(r.y, wa.y)
    if (interW >= 80 && interH >= 80) return r
  }
  return null
}

// Expose Chrome DevTools Protocol on a fixed port in dev so external
// debuggers (electron-mcp, chrome://inspect) can attach. MUST be set
// BEFORE app.whenReady().
if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// ============== OAuth loopback: http://127.0.0.1:47823/auth/done ==============
// Sign-in opens the system browser; after the provider redirects to
// our prod server's /auth/callback, the server 302s to this tiny
// local-only HTTP server. The /auth/done HTML page renders a polished
// "You're signed in" card with an explicit "Open Cumora" button — the
// button uses the cumora:// deep link to hand the session to the app
// (works whether the app is currently running or not).
//
// Why button + deep link over silent auto-handoff:
//   - User sees a deliberate "open the app" moment instead of an
//     invisible POST that doesn't always bring Cumora to front
//   - Deep link launches the app even if it isn't running yet —
//     fresh-install + first sign-in works without a manual launch
//   - The browser tab stays put on the success page, so if Cumora
//     fails to come forward the user can click again
//
// Tokens ride in the URL fragment (#token=…) so they stay out of
// server access logs and HTTP Referer headers. macOS LaunchServices
// does log the full deep-link URL — same threat surface as any other
// cumora:// link, accepted as the cost of an explicit, user-driven
// handoff. Session TTL stays tight (30d hard / 14d idle).
//
// Single-instance lock keeps a stray second `cumora` from binding the
// same loopback port AND lets deep links routed to a NEW process bounce
// over to the already-running instance via second-instance event below.
const LOOPBACK_PORT = 47823
const DEEP_LINK_SCHEME = 'cumora'

const gotSingleInstance = app.requestSingleInstanceLock()
if (!gotSingleInstance) {
  app.quit()
}

// Track whether we already pinned the app to `regular`. The previous
// implementation re-applied `setActivationPolicy('regular')` on every
// window show/hide/closed event — 5 staggered times per call — which
// caused AppKit to re-render NSWindow shadows each invocation, producing
// the visible "main window shadow flickers many times on open" bug
// (~15 calls inside the first 3s of boot). We now mark the policy known-
// regular and skip the AppKit call entirely until something explicitly
// invalidates it (i.e. the notification panel is about to show, which is
// the only known trigger for AppKit to silently demote us to accessory).
let activationPolicyKnownRegular = false

function ensureRegularDock() {
  if (process.platform !== 'darwin') return
  if (activationPolicyKnownRegular) return
  try {
    app.setActivationPolicy('regular')
    activationPolicyKnownRegular = true
  } catch { /* swallow */ }
  try {
    if (app.dock) void app.dock.show().catch(() => {})
  } catch { /* swallow */ }
}

/** Mark the cached "we're regular" flag stale ahead of an event we know
 *  can cause AppKit to silently demote us — currently just the
 *  notification panel showing. Forces the next `ensureRegularDock()` /
 *  staggered repair to actually re-apply the activation policy. */
function invalidateActivationPolicyCache() {
  activationPolicyKnownRegular = false
}

function scheduleRegularDockRepair() {
  // Only do work when the cache wasn't already regular at entry — that's
  // the only case where we need to defend against AppKit demoting us
  // asynchronously after this event (notification panel show). When we
  // were already known-regular, this call is a no-op and we skip the
  // staggered timers entirely; that's what fixes the on-open shadow
  // flicker (previously: 5 staggered setActivationPolicy calls per
  // window event, AppKit re-rendered NSWindow shadows each time).
  const needsApply = !activationPolicyKnownRegular
  ensureRegularDock()
  if (!needsApply) return
  // Defense against silent demotion: AppKit may recompute activation
  // policy a few hundred ms after a panel show. Re-invalidate the cache
  // inside each timer so the repair actually re-applies (idempotent at
  // worst, repaired-in-time at best).
  for (const delay of [50, 250, 1000, 3000]) {
    const timer = setTimeout(() => {
      invalidateActivationPolicyCache()
      ensureRegularDock()
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }
}

// Pin the activation policy to `regular` at the earliest possible moment
// — BEFORE any BrowserWindow is constructed. On macOS, Electron's default
// is already `regular`, but pinning it explicitly here is the cheapest
// guard against any later code path (notification panel, accessory-style
// auxiliary windows, etc.) that might cause AppKit to recompute and
// demote the app to `accessory`. Calling this before `whenReady()` is
// supported and lands during the NSApp setup, well before any window
// exists to influence the decision.
if (process.platform === 'darwin') {
  ensureRegularDock()
  // Previously: attached show/hide/closed listeners to EVERY window via
  // `browser-window-created`, so the main window's first `show` event
  // alone triggered 5 staggered `setActivationPolicy` calls — visible
  // as a series of shadow flickers. The notification panel is the only
  // window that can actually cause AppKit to demote us, and its own
  // create-path handles repair locally (see createNotificationWindow).
}

// Register the app as the OS handler for cumora:// links. In dev this
// only persists until the dev process ends (Electron writes to LSDb
// each launch); packaged builds get a durable registration via the
// `build.protocols` entry in package.json.
if (process.defaultApp) {
  // `process.defaultApp` is true when Electron is run from CLI (dev).
  // The argv[1] is the script path — register so macOS knows which
  // executable to invoke for cumora:// URLs.
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
}

/** HTML served at /auth/done. Self-contained: no external assets, so
 *  it renders identically online/offline. Shows a "You're signed in"
 *  card with an explicit Open Cumora button — clicking it navigates
 *  to `cumora://auth#token=…` so the OS hands the URL to the running
 *  Cumora app (open-url on macOS, second-instance argv on Win/Linux),
 *  launching it if it isn't already running. */
const AUTH_DONE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cumora — Signed in</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
    background: linear-gradient(180deg, #F8FBFD 0%, #EDF4F9 100%);
    display: grid; place-items: center; color: #1A2733;
  }
  .card {
    width: min(420px, calc(100vw - 32px));
    background: #fff;
    border-radius: 18px;
    padding: 40px 32px 32px;
    box-shadow: 0 30px 60px -30px rgba(10, 30, 60, 0.20), 0 0 0 1px rgba(0, 80, 140, 0.06);
    text-align: center;
  }
  .cloud { font-size: 56px; line-height: 1; margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 500; margin: 0 0 6px; letter-spacing: -0.01em; }
  .sub { font-style: italic; font-size: 13.5px; color: #65778A; margin: 0 0 28px; }
  /* Same shape + color story as the website's Download CTA: flat sky-
     blue rectangle with generous rounding, white label, no gradients,
     soft tinted shadow. Hover lifts a touch + darkens the surface a
     hair. */
  .btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    border: 0;
    border-radius: 14px;
    padding: 14px 28px;
    font-size: 15px;
    font-weight: 600;
    font-family: inherit;
    letter-spacing: 0.005em;
    color: #fff;
    background: #0BB3F0;
    cursor: pointer;
    transition: transform 140ms ease, background 160ms ease, box-shadow 200ms ease;
    box-shadow:
      0 8px 18px -6px rgba(11, 179, 240, 0.55),
      0 2px 4px rgba(11, 179, 240, 0.20);
  }
  .btn:hover {
    background: #0AA5E0;
    transform: translateY(-1px);
    box-shadow:
      0 12px 24px -6px rgba(11, 179, 240, 0.6),
      0 3px 6px rgba(11, 179, 240, 0.22);
  }
  .btn:active { transform: translateY(0); background: #0997D0; }
  .btn:disabled {
    background: #B7D7E6;
    cursor: default;
    box-shadow: none;
    transform: none;
  }
  .btn-mark { width: 14px; height: 14px; opacity: 0.9; }
  .hint { font-size: 11.5px; color: #8B9AAC; margin-top: 20px; font-style: italic; }
  .ok { color: #34A853; font-weight: 600; }
  .err { color: #D03A3A; font-size: 13px; margin-top: 16px; }
</style>
</head>
<body>
  <div class="card">
    <div class="cloud">☁️</div>
    <h1 id="h1">You're signed in</h1>
    <p class="sub" id="sub">Ready when you are.</p>
    <button id="open" class="btn">
      <span id="btn-label">Open Cumora</span>
      <svg class="btn-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 6l6 6-6 6"/>
      </svg>
    </button>
    <p class="hint" id="hint">You can close this tab after Cumora opens.</p>
    <p class="err" id="err" style="display:none"></p>
  </div>
<script>
(() => {
  // Token must stay in the fragment (out of access logs). Waitlist/error
  // signals are non-secret and the server prefers query string for them so
  // they survive cross-origin redirects that drop fragments. Read both so
  // either shape works.
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const queryParams = new URLSearchParams(location.search);
  const params = { get: (k) => hashParams.get(k) ?? queryParams.get(k) };
  const token = params.get('token');
  const companyId = params.get('companyId');
  // Single-use nonce the app armed with (round-tripped via the return URL's
  // query). Threaded back into the deep link so main can verify this handoff
  // was app-initiated (anti session-fixation).
  const nonce = params.get('n');
  const error = params.get('error');
  const h1 = document.getElementById('h1');
  const sub = document.getElementById('sub');
  const btn = document.getElementById('open');
  const label = document.getElementById('btn-label');
  const hint = document.getElementById('hint');
  const err = document.getElementById('err');

  if (error) {
    h1.textContent = 'Sign-in failed';
    sub.textContent = '';
    btn.style.display = 'none';
    hint.style.display = 'none';
    err.style.display = 'block';
    err.textContent = decodeURIComponent(error);
    return;
  }
  // Waitlist gate is on and this email isn't an admin: server enqueued
  // them instead of minting a session. No token to deep-link, so we
  // surface the confirmation here in the browser tab the user is already
  // looking at — same shape as the renderer's WaitlistConfirmedScreen.
  if (params.get('waitlist') === '1') {
    const email = params.get('email');
    h1.textContent = "You're on the waitlist";
    sub.textContent = email
      ? 'We saved ' + email + ' and will let you know the moment your account is ready.'
      : 'We saved your email and will let you know the moment your account is ready.';
    btn.style.display = 'none';
    hint.style.display = 'none';
    return;
  }
  if (!token) {
    h1.textContent = 'No session token';
    sub.textContent = 'Try signing in again from Cumora.';
    btn.style.display = 'none';
    hint.style.display = 'none';
    return;
  }

  // Build the deep link. Token + companyId ride in the URL fragment
  // so they're not URL-encoded as a query string (cleaner) and don't
  // appear in any web-server access logs along the path (we never
  // navigate to a remote URL here — the OS routes the cumora:// scheme
  // directly to the local app).
  const frag = new URLSearchParams({ token });
  if (companyId) frag.set('companyId', companyId);
  if (nonce) frag.set('n', nonce);
  const deepLink = 'cumora://auth#' + frag.toString();

  // PRIMARY handoff: POST straight back to the loopback server that served
  // this page. Same origin, so no CORS and no preflight, and the token goes
  // to THE process that armed the nonce — the one waiting for it.
  //
  // The deep link below cannot do that. The cumora:// scheme is resolved by
  // the OS against whatever it has registered for it, which on a dev
  // machine is regularly the WRONG binary: an unpackaged "electron ." run
  // registers its Electron.app bundle, so a stray "npx electron" (or an old
  // release/ build, or a mounted DMG) can win the scheme and swallow every
  // sign-in — the token opens a stranger's window and the app you are
  // actually running never sees it. It stays as the fallback for the case
  // this POST can't cover: the app quit between opening the browser and
  // finishing, so nothing is listening here anymore.
  fetch('/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, companyId, nonce }),
  }).then((r) => {
    if (!r.ok) throw new Error('handoff rejected: ' + r.status);
    h1.textContent = 'Signed in';
    sub.textContent = 'Cumora has your session.';
    label.innerHTML = '<span class="ok">✓</span> Signed in';
    btn.disabled = true;
    hint.textContent = 'You can close this tab.';
  }).catch(() => {
    // Loopback gone (app quit) or handoff refused — offer the OS route.
    sub.textContent = 'Ready when you are.';
    hint.textContent = 'You can close this tab after Cumora opens.';
  });

  let opened = false;
  btn.addEventListener('click', () => {
    if (opened) return;
    opened = true;
    location.href = deepLink;
    // Optimistic confirmation — the OS handler is fire-and-forget. If
    // the app fails to open (e.g. uninstalled), the user can still
    // click again; we re-enable after a short delay.
    label.innerHTML = '<span class="ok">✓</span> Opening Cumora…';
    btn.disabled = true;
    setTimeout(() => {
      opened = false;
      btn.disabled = false;
      label.textContent = 'Open Cumora again';
    }, 2500);
  });
})();
</script>
</body>
</html>`

// ============== Auth-handoff nonce (anti session-fixation) ==============
// An inbound `cumora://auth#token=…` deep link is otherwise unauthenticated:
// any web page the user visits can navigate to that scheme and silently log
// the app into the ATTACKER's account (session fixation). We defend with a
// single-use nonce that only the app can originate: the renderer asks main to
// ARM before opening the browser, threads the nonce through the OAuth return
// URL (server round-trips it back onto the /auth/done page), and every inbound
// token must carry the matching armed nonce or it's dropped. A drive-by deep
// link has no valid nonce because the app never armed for it.
//
// The armed state is in-memory: the normal desktop flow keeps the app open
// across the browser OAuth detour, so it's armed when the token returns. If
// the user QUITS the app mid-sign-in, a deep link that cold-starts a fresh
// process finds no armed nonce and is (correctly) dropped — they just sign in
// again from the now-running app. That rare edge is the accepted cost of not
// persisting a bearer-handoff credential to disk.
let armedAuthNonce = null
let armedAuthExpiry = 0
const AUTH_NONCE_TTL_MS = 10 * 60 * 1000

/** Arm for one sign-in and return a fresh nonce the renderer appends to the
 *  OAuth return URL. Supersedes any previous unused nonce. */
function armAuthHandoff() {
  armedAuthNonce = crypto.randomBytes(16).toString('hex')
  armedAuthExpiry = Date.now() + AUTH_NONCE_TTL_MS
  return armedAuthNonce
}

/** Validate + single-use-consume an inbound nonce. Constant-time compare so a
 *  mismatch leaks nothing; clears the armed nonce on any check so a token can
 *  be accepted at most once. */
function consumeAuthNonce(nonce) {
  const armed = armedAuthNonce
  const expiry = armedAuthExpiry
  armedAuthNonce = null
  armedAuthExpiry = 0
  if (!armed || Date.now() > expiry) return false
  if (typeof nonce !== 'string' || nonce.length !== armed.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(armed))
  } catch {
    return false
  }
}

/** Pull token + companyId + nonce out of a `cumora://auth#token=…` URL. The OS
 *  hands us the full URL on open-url / second-instance; we only care
 *  about the fragment. Returns null if the URL isn't auth-shaped. */
function parseAuthDeepLink(rawUrl) {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== DEEP_LINK_SCHEME + ':') return null
    if (u.hostname !== 'auth' && u.pathname !== '//auth' && u.pathname !== '/auth') return null
    const hash = (u.hash || '').replace(/^#/, '')
    const params = new URLSearchParams(hash)
    const token = params.get('token')
    if (!token || token.length < 8) return null
    return { token, companyId: params.get('companyId'), nonce: params.get('n') }
  } catch {
    return null
  }
}

/** Push token+companyId into the renderer — but ONLY for a handoff this app
 *  itself initiated (matching armed nonce). Bringing the main window forward
 *  is the polish touch — the user came from the browser, they want Cumora on
 *  top. An inbound token with a missing/stale/wrong nonce is dropped. */
function dispatchAuthToken(token, companyId, nonce) {
  if (!consumeAuthNonce(nonce)) {
    console.warn('[auth] dropped inbound token: no matching armed nonce (possible drive-by deep link)')
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('auth:token', { token, companyId })
  } else {
    pendingAuthToken = { token, companyId }
  }
}
let pendingAuthToken = null

/** Reference to the auth loopback HTTP server. Held so `before-quit`
 *  can `.close()` it — otherwise the listening socket keeps Node's event
 *  loop alive after all windows close and the user is forced to
 *  Activity-Monitor-kill the process. */
let authLoopbackServer = null

function startAuthLoopback() {
  const server = http.createServer((req, res) => {
    // Cross-origin protection: only accept requests whose Origin (when
    // present) is empty (top-level navigation) or self. Belt-and-suspenders
    // against a malicious page on another origin POSTing tokens at us.
    const origin = req.headers.origin
    const selfOrigin = `http://127.0.0.1:${LOOPBACK_PORT}`
    if (origin && origin !== selfOrigin) {
      res.statusCode = 403; res.end('forbidden'); return
    }
    if (req.method === 'GET' && (req.url === '/auth/done' || req.url.startsWith('/auth/done?'))) {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(AUTH_DONE_HTML)
      return
    }
    if (req.method === 'POST' && req.url === '/auth/token') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        // 4kb cap — token is base64url 32 bytes, companyId ~14 chars.
        // Anything over this is malicious or buggy.
        if (body.length > 4096) { req.destroy(); }
      })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          if (typeof parsed?.token !== 'string' || parsed.token.length < 8) {
            res.statusCode = 400; res.end('bad token'); return
          }
          const companyId = typeof parsed.companyId === 'string' ? parsed.companyId : null
          const nonce = typeof parsed.nonce === 'string' ? parsed.nonce : null
          dispatchAuthToken(parsed.token, companyId, nonce)
          res.statusCode = 204; res.end()
        } catch {
          res.statusCode = 400; res.end('bad json')
        }
      })
      return
    }
    res.statusCode = 404; res.end('not found')
  })
  server.on('error', (e) => {
    console.warn('[auth-loopback] server error', e.message || e)
  })
  server.listen(LOOPBACK_PORT, '127.0.0.1', () => {
    console.log(`[auth-loopback] listening on http://127.0.0.1:${LOOPBACK_PORT}`)
  })
  authLoopbackServer = server
}

// Resolve once — used for `BrowserWindow.icon` (Win/Linux taskbar) and for
// `app.dock.setIcon` on macOS so the dock / cmd-tab in dev mode show the
// cumora cloud instead of Electron's default.
const ICON_PATH = path.join(app.getAppPath(), 'build', 'icon.png')
const DOCK_ICON_SIZE = 1024
const DOCK_UNREAD_DOT = {
  cx: 770,
  cy: 232,
  r: 48,
  stroke: 18,
}

/** True once an actual quit is in flight (Cmd-Q, tray menu Quit,
 *  window-all-closed on Win/Linux — anything that flows through
 *  `before-quit`). The main window's `close` handler checks this flag
 *  and falls through to a real close; otherwise it hides to tray. */
let appIsQuitting = false

/** The "real" app window. */
let mainWindow = null
/** Frameless transparent always-on-top window pinned to the top-right
 *  of the primary display. Renders the same React bundle with the
 *  `#notifications` hash so it shows only the toast stack. Hidden when
 *  there are no live toasts, shown (without stealing focus) on push. */
let notificationWindow = null

const NOTIF_WIDTH = 360
const NOTIF_HEIGHT_MAX = 480
const NOTIF_MARGIN_RIGHT = 16
const NOTIF_MARGIN_TOP = 24

function notificationUrl() {
  if (isDev) return `${DEV_URL}/#notifications`
  // Same `app://` scheme the main window loads (see the header comment): over
  // `file://` the bundle's absolute `/assets/…` imports resolve outside the asar
  // and 404, so the renderer never boots — meaning `notification:ready` never
  // fires, every push queues in pendingPushes forever, and a packaged build
  // shows no toasts and plays no chime at all.
  return 'app://cumora/index.html#notifications'
}

function positionNotificationWindow() {
  if (!notificationWindow) return
  const display = screen.getPrimaryDisplay()
  const { x, y, width } = display.workArea
  notificationWindow.setBounds({
    x: x + width - NOTIF_WIDTH - NOTIF_MARGIN_RIGHT,
    y: y + NOTIF_MARGIN_TOP,
    width: NOTIF_WIDTH,
    height: NOTIF_HEIGHT_MAX,
  })
}

/** Queue of pushes that arrived before the notification renderer
 *  signalled `notification:ready`. Flushed once the renderer mounts. */
let pendingPushes = []
let notificationReady = false
let dockUnreadDotVisible = false
let dockCleanIcon = null
let dockUnreadIcon = null

function getDockCleanIcon() {
  if (!dockCleanIcon) dockCleanIcon = nativeImage.createFromPath(ICON_PATH)
  return dockCleanIcon
}

/** Paint the unread dot straight into an app-icon bitmap, in place.
 *
 *  Same raw-bitmap route as the tray below, for the same reason its comment
 *  gives: `nativeImage.createFromDataURL` only decodes raster formats Chromium
 *  knows (PNG/JPEG/WebP/GIF), so the SVG this used to build produced an EMPTY
 *  image — `isEmpty()` true at 0x0. That tripped the `!img.isEmpty()` guard in
 *  setDockUnreadDot, which skipped `setIcon` entirely, so the dock never showed
 *  any unread indicator while the tray (already on bitmaps) did.
 *
 *  Buffer layout is BGRA with PREMULTIPLIED alpha (Chromium's N32). Blending
 *  `c*a + dst*(1-a)` on all four channels preserves that invariant, since a
 *  premultiplied channel never exceeds its alpha.
 *
 *  Dot geometry stays in the existing 1024-unit design space and is scaled to
 *  whatever the icon's real pixel size is, so DOCK_UNREAD_DOT keeps its
 *  meaning. */
function paintDockUnreadDot(buf, width, height) {
  const s = Math.min(width, height) / DOCK_ICON_SIZE
  const dot = DOCK_UNREAD_DOT
  const cx = dot.cx * s
  const cy = dot.cy * s
  const rIn = dot.r * s
  const rOut = (dot.r + dot.stroke / 2) * s
  const SS = 4  // 4x4 supersample — the same cheap anti-aliasing the tray uses
  const n = SS * SS
  const blend = (i, b, g, r, a) => {
    if (a <= 0) return
    const inv = 1 - a
    buf[i] = Math.round(b * a + buf[i] * inv)
    buf[i + 1] = Math.round(g * a + buf[i + 1] * inv)
    buf[i + 2] = Math.round(r * a + buf[i + 2] * inv)
    buf[i + 3] = Math.round(255 * a + buf[i + 3] * inv)
  }
  const x0 = Math.max(0, Math.floor(cx - rOut - 1))
  const x1 = Math.min(width - 1, Math.ceil(cx + rOut + 1))
  const y0 = Math.max(0, Math.floor(cy - rOut - 1))
  const y1 = Math.min(height - 1, Math.ceil(cy + rOut + 1))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let covIn = 0
      let covOut = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - cx
          const dy = y + (sy + 0.5) / SS - cy
          const d2 = dx * dx + dy * dy
          if (d2 <= rOut * rOut) covOut += 1
          if (d2 <= rIn * rIn) covIn += 1
        }
      }
      if (covOut === 0) continue
      const i = (y * width + x) * 4
      // White halo first, then the red dot on top — same z-order as before.
      blend(i, 255, 255, 255, (covOut / n) * 0.96)
      blend(i, 0x30, 0x3b, 0xff, covIn / n)
    }
  }
}

function getDockUnreadIcon() {
  if (dockUnreadIcon) return dockUnreadIcon
  const base = nativeImage.createFromPath(ICON_PATH)
  const { width, height } = base.getSize()
  // No icon on disk (or an undecodable one) — hand back the empty image and let
  // setDockUnreadDot's isEmpty() guard skip the update, exactly as before.
  if (!width || !height) return base
  const buf = base.toBitmap()
  paintDockUnreadDot(buf, width, height)
  dockUnreadIcon = nativeImage.createFromBitmap(buf, { width, height })
  return dockUnreadIcon
}

function setDockUnreadDot(visible) {
  dockUnreadDotVisible = !!visible
  if (process.platform !== 'darwin' || !app.dock) return
  try {
    app.dock.setBadge('')
    const img = dockUnreadDotVisible ? getDockUnreadIcon() : getDockCleanIcon()
    if (!img.isEmpty()) app.dock.setIcon(img)
  } catch { /* swallow — Dock is macOS-only and not critical path */ }
  scheduleRegularDockRepair()
  // Mirror to the system tray so menu bar / system tray surfaces stay
  // in sync with the dock. Cheap to call when there's no tray (no-op).
  setTrayUnreadDot(dockUnreadDotVisible)
}

/* ============================ System tray ============================
 * Menu bar item on macOS, system tray on Win/Linux. Same unread-dot
 * indicator the dock uses (we reuse `dockUnreadDotVisible` as the
 * authoritative state). Click toggles the main window; right-click
 * shows a context menu with Open / Hide / Quit. Closing the X on the
 * main window hides instead of quitting (true quit is via tray menu
 * Quit or Cmd-Q / window-all-closed on Win+Linux). */
let tray = null
let trayCleanIcon = null
let trayUnreadIcon = null

/** Hand-rasterise a cloud silhouette to a BGRA pixel buffer and feed
 *  it to `nativeImage.createFromBitmap`. Why the bytes-level approach:
 *  `nativeImage.createFromDataURL` only decodes raster formats Chromium
 *  knows (PNG/JPEG/WebP/GIF) — SVG data URLs silently produce an empty
 *  image, which is why the old SVG-based tray icon never appeared. Raw
 *  bitmap input has none of those decoder constraints.
 *
 *  Shape: three overlapping circles (left/center/right lobes) on top
 *  of a rounded baseline rectangle — the classic cloud-glyph union,
 *  tuned to read like the brand's pudgy cloud at 22pt menu bar size.
 *  All fill is pure black (B=G=R=0); we drive macOS template-image
 *  inversion via `setTemplateImage(true)` after the fact. The unread
 *  variant adds a small filled circle outside the silhouette in the
 *  upper-right — still pure black so the same template-inversion
 *  pipeline keeps working in dark mode. */
const TRAY_ICON_SIZE = 64  // generation size; menu bar downsamples to 22pt automatically

function buildTrayCloudBitmap({ dot = false } = {}) {
  const size = TRAY_ICON_SIZE
  // Design space is 64 units; scale to the chosen pixel size so we can
  // tweak TRAY_ICON_SIZE later (e.g. 128 for sharper retina) without
  // rewriting coordinates.
  const s = size / 64
  const lobes = [
    { cx: 20 * s, cy: 34 * s, r: 10 * s },
    { cx: 32 * s, cy: 22 * s, r: 14 * s },
    { cx: 46 * s, cy: 30 * s, r: 11 * s },
  ]
  const base = { x: 10 * s, y: 32 * s, w: 44 * s, h: 20 * s, r: 10 * s }
  const dotCircle = dot ? { cx: 56 * s, cy: 10 * s, r: 7 * s } : null

  const insideCircle = (px, py, c) => {
    const dx = px - c.cx, dy = py - c.cy
    return dx * dx + dy * dy <= c.r * c.r
  }
  // Rounded-rect inclusion: clamp the test point to the rect's inner
  // axis-aligned bounding box (deflated by corner radius) and check
  // distance from that clamped point — exactly the standard SDF for a
  // rounded box at distance ≤ r.
  const insideRoundedRect = (px, py, b) => {
    const closestX = Math.max(b.x + b.r, Math.min(px, b.x + b.w - b.r))
    const closestY = Math.max(b.y + b.r, Math.min(py, b.y + b.h - b.r))
    const dx = px - closestX, dy = py - closestY
    if (dx * dx + dy * dy <= b.r * b.r) return true
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h &&
           ((px >= b.x + b.r && px <= b.x + b.w - b.r) || (py >= b.y + b.r && py <= b.y + b.h - b.r))
  }
  const inside = (px, py) => {
    for (const c of lobes) if (insideCircle(px, py, c)) return true
    if (insideRoundedRect(px, py, base)) return true
    if (dotCircle && insideCircle(px, py, dotCircle)) return true
    return false
  }

  const buf = Buffer.alloc(size * size * 4)
  // 4×4 supersample for cheap anti-aliasing — at 64×64 this is ~16k
  // shape-tests, single-digit ms in V8, runs once at boot and once on
  // first unread. Worth the crispness.
  const SS = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          if (inside(px, py)) hit++
        }
      }
      const alpha = Math.round((hit / (SS * SS)) * 255)
      const idx = (y * size + x) * 4
      buf[idx + 0] = 0      // B
      buf[idx + 1] = 0      // G
      buf[idx + 2] = 0      // R
      buf[idx + 3] = alpha  // A — coverage from the supersample
    }
  }
  return buf
}

function makeTrayImageFromBitmap(buffer) {
  const img = nativeImage.createFromBitmap(buffer, { width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE })
  // Mark as template ONLY on macOS — AppKit then handles all theming
  // (light/dark menu bar, highlight on click) automatically. On
  // Win/Linux template-ness is a no-op; the black silhouette renders
  // as-is, which is the standard look on those platforms too.
  if (process.platform === 'darwin') {
    try { img.setTemplateImage(true) } catch { /* swallow */ }
  }
  return img
}

/** Load a pre-rendered tray template PNG. The cloud silhouette + the
 *  unread-badge variant are baked from `public/logo.png` (the real
 *  brand cloud — alpha-transparent background, cloud body as the
 *  largest connected component) by `scripts-gen-tray-icons.py` and
 *  committed under `build/`:
 *
 *    build/tray-template.png         (22×22 — 1×)
 *    build/tray-template@2x.png      (44×44 — Retina)
 *    build/tray-template@3x.png      (66×66 — XDR)
 *    build/tray-template-unread.png  (+ @2x / @3x variants)
 *
 *  Re-run that script after touching `public/logo.png` and the menu
 *  bar icon tracks. Why baked-on-disk rather than runtime composition:
 *    • `nativeImage.createFromDataURL('data:image/svg+xml,…')` returns
 *      an empty image — Electron decodes only PNG/JPEG/WebP/GIF from
 *      data URLs, so SVG silently fails (which is why the tray icon
 *      disappeared in earlier attempts).
 *    • Largest-connected-component extraction is O(width·height) —
 *      fine once at build time, wasteful on every Electron boot.
 *    • Electron auto-picks the right `@2x`/`@3x` sibling for the
 *      screen's scale factor when you call createFromPath on the 1×
 *      base, so we get pixel-perfect rendering on every display with
 *      zero runtime cost. */
function loadTrayTemplate(suffix) {
  const p = path.join(app.getAppPath(), 'build', `tray-template${suffix}.png`)
  const img = nativeImage.createFromPath(p)
  if (img.isEmpty()) return null
  if (process.platform === 'darwin') {
    // AppKit handles light/dark menu-bar inversion + click-highlight
    // tinting automatically once we mark this as a template. Off-darwin
    // it's a no-op; the black silhouette renders as-is, which is the
    // standard look on Win/Linux system trays too.
    try { img.setTemplateImage(true) } catch { /* swallow */ }
  }
  return img
}

function getTrayCleanIcon() {
  if (trayCleanIcon) return trayCleanIcon
  trayCleanIcon = loadTrayTemplate('') ?? makeTrayImageFromBitmap(buildTrayCloudBitmap({ dot: false }))
  return trayCleanIcon
}

function getTrayUnreadIcon() {
  if (trayUnreadIcon) return trayUnreadIcon
  trayUnreadIcon = loadTrayTemplate('-unread') ?? makeTrayImageFromBitmap(buildTrayCloudBitmap({ dot: true }))
  return trayUnreadIcon
}

function setTrayUnreadDot(visible) {
  if (!tray || tray.isDestroyed?.()) return
  try {
    const img = visible ? getTrayUnreadIcon() : getTrayCleanIcon()
    if (!img.isEmpty()) tray.setImage(img)
  } catch { /* swallow — tray isn't critical path */ }
}

function toggleMainWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: `Cumora v${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Cumora', click: () => {
      if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return }
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } },
    { label: 'Hide Window', click: () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide()
    } },
    { type: 'separator' },
    { label: 'Quit Cumora', click: () => {
      // before-quit will set appIsQuitting=true and tear down the
      // notification window + auth loopback server; this is the only
      // legitimate exit path that bypasses the close-to-hide trap.
      app.quit()
    } },
  ])
}

function createTray() {
  if (tray) return
  const img = getTrayCleanIcon()
  if (img.isEmpty()) {
    console.warn('[tray] no icon — skipping tray creation')
    return
  }
  tray = new Tray(img)
  tray.setToolTip('Cumora')
  // macOS: don't `setContextMenu` — Electron's docs are explicit that
  // doing so swallows the `click` event entirely, making left-click
  // toggle-window impossible. Instead handle `click` ourselves and
  // pop the menu manually on `right-click`.
  tray.on('click', toggleMainWindowVisibility)
  tray.on('right-click', () => {
    try { tray.popUpContextMenu(buildTrayMenu()) } catch { /* swallow */ }
  })
  if (process.platform !== 'darwin') {
    // Win/Linux: setContextMenu drives the right-click menu reliably
    // across DEs; left-click still hits our `click` handler above.
    tray.setContextMenu(buildTrayMenu())
  }
  // Restore unread state in case set-unread-dot was called before tray
  // existed (dock was, but tray wasn't — keep the two in lockstep).
  setTrayUnreadDot(dockUnreadDotVisible)
}

function createNotificationWindow() {
  notificationWindow = new BrowserWindow({
    width: NOTIF_WIDTH,
    // Start small — renderer will report exact content height once
    // the toast paints, and we resize then. Without dynamic sizing the
    // vibrant material below would fill a 360×480 rectangle of frosted
    // glass with a tiny toast at the top — ugly.
    height: 120,
    show: false,
    frame: false,
    // alma's recipe: `transparent: true` everywhere + NO vibrancy. The
    // window's empty pixels stay genuinely transparent — the desktop is
    // visible directly underneath, NOT covered by an NSVisualEffectView
    // material rectangle. The toast card brings its own desktop blur via
    // CSS `backdrop-filter` (see NotificationWindow.tsx). Without this,
    // vibrancy 'under-window' paints frosted material across the entire
    // 360×N window bounds, producing the gray slab below the toast.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // Disable Electron's automatic macOS window-edge rounding. The toast
    // card draws its own border-radius (CSS, 14px); leaving the system
    // rounding on would clip the card's bottom-right corner. wails-gui
    // and alma both omit any window-level rounding for the same reason.
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    // IMPORTANT: must be `true`, NOT `false`. `focusable: false` sets the
    // underlying NSWindow's `canBecomeKeyWindow = NO`, and AppKit reacts
    // to a non-key-capable panel becoming visible by recomputing the
    // app's activation policy: if no currently visible window can become
    // key (very common at boot — main window is still `show: false`
    // until `ready-to-show`), the app gets demoted to `accessory` and
    // the Dock icon vanishes. We don't want that.
    //
    // Click-through is enforced by `setIgnoreMouseEvents(true)` below;
    // showInactive() keeps the panel from stealing focus at show time;
    // `type: 'panel'` (NSNonactivatingPanel) ensures even a focused
    // click doesn't activate the whole app. So `focusable: true` is
    // safe — the panel never actually becomes key in practice, AppKit
    // just stops worrying about the app's foreground status.
    //
    // This matches Alma's quickChatWin (also `focusable: true` +
    // `type: 'panel'`), which is why Alma never had to call
    // `setActivationPolicy` to keep its dock icon.
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    // macOS NSPanel-style window. Critical because it:
    //  - never activates the app on click (background clicks no longer
    //    pull the main Cumora window forward)
    //  - doesn't appear in Mission Control / window-tab cycles
    //  - combined with `focusable: true` above, doesn't trigger the
    //    accessory-policy demotion that hides the Dock icon
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Panel is shown via `showInactive()` and is click-through by
      // default, so it never receives a real user-gesture activation
      // even though `focusable: true`. Without this, Web Audio's
      // autoplay policy keeps the AudioContext suspended and the chime
      // can never play from this renderer.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // Transparent page surface is established via the constructor
  // option `backgroundColor: '#00000000'` above — that's the supported
  // path in modern Electron. Earlier versions also exposed
  // `webContents.setBackgroundColor(...)` for this, but it was removed
  // and calling it now throws "setBackgroundColor is not a function".
  //
  // `pop-up-menu` rather than `screen-saver` — the screen-saver level
  // (kCGScreenSaverWindowLevel) floats so high it sits over menus; the
  // pop-up-menu level floats well above the main window without that.
  notificationWindow.setAlwaysOnTop(true, 'pop-up-menu')
  // THE Dock-icon-vanishing fix. On macOS, `setVisibleOnAllWorkspaces`
  // DEFAULTS to transforming NSApp's process type between
  // `ForegroundApplication` and `UIElementApplication` (the latter is
  // the accessory/agent type — no Dock icon). So the moment the first
  // toast painted and we called this, Cumora flipped to UIElement and
  // the Dock icon disappeared. `skipTransformProcessType: true` tells
  // Electron to set the cross-Space collection behavior WITHOUT touching
  // the process type, so the panel still shows on every Space / over
  // fullscreen apps while the Dock icon stays put. This is the root-cause
  // fix; the `scheduleRegularDockRepair()` machinery below is now just a
  // belt-and-suspenders backstop, not the thing holding the icon on.
  notificationWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })
  // Default to click-through; renderer flips it off while a toast is on
  // screen via `notification:set-interactive`. With `type: 'panel'`
  // alone, clicks on the empty area would still hit-test on this
  // window — even though they no longer activate Cumora, they'd still
  // block clicks reaching whatever's underneath.
  notificationWindow.setIgnoreMouseEvents(true, { forward: true })

  positionNotificationWindow()
  void notificationWindow.loadURL(notificationUrl())

  notificationWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[NOTIFY:main] notification window load FAILED', { code, desc, url })
  })
  notificationWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[NOTIFY:main] notification renderer GONE', details)
  })

  // Belt-and-suspenders for the Dock-icon-vanishing bug. The primary
  // fix is `focusable: true` above — that's what stops AppKit from
  // demoting the app when the panel is shown. But the demotion (when
  // it happens at all) is triggered AT SHOW TIME, not at construction,
  // so the right place to re-assert `regular` is the `show` event, not
  // synchronously after `new BrowserWindow`. Also calling `dock.show()`
  // explicitly because some Electron/macOS combinations don't refresh
  // the Dock visibility from `setActivationPolicy` alone.
  if (process.platform === 'darwin') {
    notificationWindow.on('show', scheduleRegularDockRepair)
    notificationWindow.on('closed', scheduleRegularDockRepair)
  }

  notificationWindow.on('closed', () => {
    notificationWindow = null
    notificationReady = false
    pendingPushes = []
  })
}

// Re-position whenever displays change. We attach once at app start
// instead of inside createNotificationWindow so we don't double-attach
// the listener every time the window is recreated.
function attachDisplayListeners() {
  screen.on('display-metrics-changed', positionNotificationWindow)
  screen.on('display-added', positionNotificationWindow)
  screen.on('display-removed', positionNotificationWindow)
}

function createWindow() {
  const saved = readWindowState() ?? DEFAULT_WINDOW_STATE
  const rect = visibleRect(saved)
  // Cap initial size to fit comfortably inside the primary display's
  // work area — 90% of work area, with the configured default as the
  // upper ceiling. Without this, the 1480×920 default would exceed
  // smaller laptop displays and macOS would clamp on launch, making
  // every first-run feel "fullscreen".
  const wa = screen.getPrimaryDisplay().workArea
  const initW = Math.min(saved.width ?? DEFAULT_WINDOW_STATE.width, Math.round(wa.width * 0.9))
  const initH = Math.min(saved.height ?? DEFAULT_WINDOW_STATE.height, Math.round(wa.height * 0.9))
  mainWindow = new BrowserWindow({
    width: initW,
    height: initH,
    // Only restore position if the rect is still inside a connected
    // display. Otherwise let the OS center the window — avoids opening
    // off-screen when the user disconnects a monitor.
    ...(rect ? { x: rect.x, y: rect.y } : {}),
    // Constructor flag — overrides macOS NSWindow state restoration's
    // "open fullscreen because it was fullscreen last quit" behaviour.
    // We apply our own fullscreen/maximize state right after `show`.
    fullscreen: false,
    // In dev, relax the floor so the window can shrink past the 768px
    // mobile breakpoint (defined in src/lib/utils.ts) — lets us debug the
    // mobile layout without spinning up a separate device emulator.
    // Production keeps the comfortable desktop floor.
    minWidth: isDev ? 320 : 900,
    minHeight: isDev ? 480 : 600,
    show: false,
    backgroundColor: '#E6F3FB',
    icon: ICON_PATH,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium throttles timers + some idle work when the window is
      // hidden. We rely on the WS subscriber firing promptly to surface
      // background notifications, so opt out.
      backgroundThrottling: false,
    },
  })

  // Forward native OS-level focus state to the renderer. We can't rely on
  // `document.hasFocus()` from inside the renderer — in Electron on macOS
  // it returns stale `true` values when the window is unfocused, which
  // suppresses the screen-corner notification.
  //
  // We also can't rely on `BrowserWindow.on('blur'/'focus')` alone — on
  // some macOS versions with `titleBarStyle: 'hidden'` those events skip
  // transitions when focus passes through the menu bar or Mission
  // Control. Use both: events fire fast on direct focus changes, and a
  // 500ms heartbeat catches everything the events miss.
  let lastEmittedFocus = null
  const sendFocusState = (focused, _reason) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (focused === lastEmittedFocus) return
    lastEmittedFocus = focused
    mainWindow.webContents.send('app:focus-state', focused)
  }
  const pollFocus = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    sendFocusState(mainWindow.isFocused(), 'poll')
  }
  mainWindow.on('focus', () => sendFocusState(true, 'focus'))
  mainWindow.on('blur', () => sendFocusState(false, 'blur'))
  mainWindow.on('show', () => sendFocusState(mainWindow.isFocused(), 'show'))
  mainWindow.on('hide', () => sendFocusState(false, 'hide'))
  const focusPollTimer = setInterval(pollFocus, 500)

  // Debounced state persistence. We don't write on every pixel of a
  // drag/resize — wait 300ms of quiet then snapshot getNormalBounds (the
  // pre-maximize/fullscreen size, so we restore the user's actual chosen
  // size rather than the maximized rect).
  let saveTimer = null
  const persistState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const bounds = mainWindow.getNormalBounds()
    writeWindowState({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      fullscreen: mainWindow.isFullScreen(),
      maximized: mainWindow.isMaximized(),
    })
  }
  const queueSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(persistState, 300)
  }
  mainWindow.on('resize', queueSave)
  mainWindow.on('move', queueSave)
  mainWindow.on('maximize', queueSave)
  mainWindow.on('unmaximize', queueSave)
  mainWindow.on('enter-full-screen', queueSave)
  mainWindow.on('leave-full-screen', queueSave)
  mainWindow.on('close', (event) => {
    // Close-to-hide: clicking the window's X (or otherwise asking it to
    // close) just hides it to the tray, keeping the WS connection alive
    // so notifications keep arriving. True quit only happens when
    // `appIsQuitting` is set — which the tray menu's Quit, Cmd-Q, and
    // window-all-closed (Win/Linux) all flow through via `before-quit`.
    // Persist state first either way so the geometry is fresh on next
    // open / launch.
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    persistState()
    // In dev we DON'T close-to-hide: the existing `closed` handler runs
    // `app.quit()` so `concurrently -k` propagates SIGTERM to vite + the
    // API server. Intercepting here would strand those children and the
    // next launch hits "port 5180 already in use".
    if (!isDev && !appIsQuitting && tray && !tray.isDestroyed?.()) {
      event.preventDefault()
      try { mainWindow.hide() } catch { /* swallow */ }
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    // Apply saved fullscreen / maximize state AFTER show so the OS
    // accepts the transition. Doing it via constructor options is
    // unreliable on macOS state-restoration paths.
    if (saved.fullscreen) mainWindow.setFullScreen(true)
    else if (saved.maximized) mainWindow.maximize()
  })

  // If a token arrived on the loopback server BEFORE the window finished
  // loading (the user was that fast), flush it now.
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingAuthToken) {
      const t = pendingAuthToken
      pendingAuthToken = null
      mainWindow.webContents.send('auth:token', t)
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (isDev) {
    void mainWindow.loadURL(DEV_URL)
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    // Serve over the app:// scheme registered above. `/` paths
    // (whether emitted by Vite or hard-coded in JSX) all flow through
    // the protocol handler in app.whenReady() and resolve from
    // <resources>/dist. No more file:// 404s.
    //
    // Host name matters: it becomes the renderer's `Origin` header on
    // any cross-origin fetch. The cumora API server's
    // CUMORA_CORS_ORIGINS allows `app://cumora` — keep that in sync, or
    // /auth/me + every other /api call gets CORS-blocked and the user
    // sits forever on the sign-in screen with a valid token in store.
    void mainWindow.loadURL('app://cumora/index.html')
  }

  mainWindow.on('closed', () => {
    clearInterval(focusPollTimer)
    mainWindow = null
    // In dev, closing the main window should also tear down the
    // notification window + the whole app so `concurrently -k` propagates
    // the kill to vite (port 5180) + the API server (port 5181).
    //
    // Without this:
    //  - macOS convention keeps the Electron process alive after window
    //    close (mac apps stay in the dock with no windows).
    //  - The notification window is `closable: false`, so `app.quit()`
    //    alone won't end the process — we destroy() it ourselves first.
    //    destroy() bypasses the closable flag and any close handlers.
    // Both together mean `pnpm electron:dev`'s child processes leak and
    // the next launch hits "port 5180 already in use".
    if (isDev) {
      if (notificationWindow && !notificationWindow.isDestroyed()) {
        notificationWindow.destroy()
      }
      app.quit()
    }
  })
}

/* ============== Notification IPC ============== */

// MAIN window pushes a toast — forward to the notification window and
// show it (without stealing focus) so the user sees it at screen top-right.
// Shared push routine. Same logic the IPC handler runs — extracted so
// dev shortcuts (and any future programmatic trigger) can fire a
// notification without rebuilding the create-on-demand state machine.
function pushNotification(payload) {
  scheduleRegularDockRepair()
  if (!notificationWindow || notificationWindow.isDestroyed()) {
    pendingPushes.push(payload)
    notificationReady = false
    createNotificationWindow()
    return
  }
  if (!notificationReady) {
    pendingPushes.push(payload)
    return
  }
  notificationWindow.webContents.send('notification:push', payload)
  scheduleRegularDockRepair()
  // Don't show here — renderer will signal `painted` after the toast
  // actually renders. Showing here risked flashing an empty 360-wide
  // rectangle before the React tree caught up.
}

ipcMain.on('notification:push', (_event, payload) => {
  pushNotification(payload)
})

ipcMain.on('dock:set-unread-dot', (_event, visible) => {
  setDockUnreadDot(!!visible)
})

// Renderer mounted + subscribed to onPush. Flush queued pushes, but
// LEAVE THE WINDOW HIDDEN — it'll be shown on the `painted` signal
// after the first toast actually renders.
ipcMain.on('notification:ready', () => {
  if (!notificationWindow || notificationWindow.isDestroyed()) return
  notificationReady = true
  for (const p of pendingPushes) {
    notificationWindow.webContents.send('notification:push', p)
  }
  pendingPushes = []
})

// Renderer has painted its first toast. Safe to show the window now.
// Position lazily here so any display change between create and paint
// (multi-monitor unplug) lands in the right spot.
ipcMain.on('notification:painted', () => {
  if (!notificationWindow || notificationWindow.isDestroyed()) return
  if (!notificationWindow.isVisible()) {
    positionNotificationWindow()
    // Showing the panel is the one event we know can demote us to
    // accessory — invalidate the cached policy state so the repair
    // actually re-applies, instead of no-opping.
    invalidateActivationPolicyCache()
    notificationWindow.showInactive()
    scheduleRegularDockRepair()
  }
  // Tell the MAIN window that a fresh toast is on screen. The main
  // window owns the chime — it's always loaded, so playing it from
  // there has zero boot delay. The small `setTimeout` ensures the
  // panel has committed to the screen BEFORE the audio starts; firing
  // synchronously made the bell beat the visible toast by ~30-50ms.
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notification:visible')
      }
    }, 120)
  }
})

// Renderer reports the exact content height. Resize the panel so the
// vibrant material (real macOS Gaussian blur) only fills the area
// occupied by the toast(s), not a full 360×480 rectangle.
ipcMain.on('notification:set-height', (_event, h) => {
  if (!notificationWindow || notificationWindow.isDestroyed()) return
  const height = Math.max(60, Math.min(NOTIF_HEIGHT_MAX, Math.ceil(Number(h) || 0)))
  const display = screen.getPrimaryDisplay()
  const wa = display.workArea
  notificationWindow.setBounds({
    x: wa.x + wa.width - NOTIF_WIDTH - NOTIF_MARGIN_RIGHT,
    y: wa.y + NOTIF_MARGIN_TOP,
    width: NOTIF_WIDTH,
    height,
  })
})

// Renderer toggles whether the notification window accepts clicks.
//  - `true`  → a toast is on screen; user must be able to click it.
//  - `false` → no toasts; destroy the window entirely so nothing sits
//              invisibly on top of the user's desktop. Cleaner than
//              hiding (the window literally doesn't exist) and matches
//              what Alma/wails-gui do with their NSPanel toasts.
ipcMain.on('notification:set-interactive', (_event, interactive) => {
  if (!notificationWindow || notificationWindow.isDestroyed()) return
  if (interactive) {
    notificationWindow.setIgnoreMouseEvents(false)
    scheduleRegularDockRepair()
  } else {
    // Destroy() bypasses `closable: false` and any close-prevent
    // handlers. `closed` resets pendingPushes + notificationReady.
    notificationWindow.destroy()
    scheduleRegularDockRepair()
  }
})

// MAIN window asks to clear a specific toast (e.g. after auto-dismiss).
ipcMain.on('notification:dismiss', (_event, id) => {
  if (!notificationWindow || notificationWindow.isDestroyed()) return
  notificationWindow.webContents.send('notification:dismiss', id)
})

// Renderer asks for the main window's current focus state synchronously
// (e.g. at boot, before the first focus/blur event has fired).
ipcMain.handle('app:is-focused', () => {
  return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused())
})

ipcMain.on('theme:set', (_event, source) => {
  if (source !== 'system' && source !== 'light' && source !== 'dark') return
  nativeTheme.themeSource = source
  if (mainWindow && !mainWindow.isDestroyed()) {
    const dark = source === 'dark' || (source === 'system' && nativeTheme.shouldUseDarkColors)
    mainWindow.setBackgroundColor(dark ? '#21252b' : '#E6F3FB')
  }
})

nativeTheme.on('updated', () => {
  if (nativeTheme.themeSource !== 'system') return
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#21252b' : '#E6F3FB')
  }
})

// Renderer asks main to open a URL in the user's default browser
// (used for OAuth — embedded webviews are banned by Google and the
// experience is better in a familiar browser anyway). Restricted to
// http/https so a compromised renderer can't shell-out arbitrary URLs.
ipcMain.handle('auth:open-external', (_event, url) => {
  if (typeof url !== 'string') return false
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false
  void shell.openExternal(url)
  return true
})

// Renderer arms a sign-in and gets a single-use nonce to thread through the
// OAuth return URL; only an inbound token carrying this nonce is accepted
// (see dispatchAuthToken / consumeAuthNonce — anti session-fixation).
ipcMain.handle('auth:arm', () => armAuthHandoff())

// NOTIFICATION window asks main to focus a conversation when user clicks
// a toast. Bring the main window forward + forward the id over to its
// renderer so the React app selects the conversation.
ipcMain.on('notification:focus-convo', (_event, conversationId) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('notification:focus-convo', conversationId)
  }
})

// ============== Deep-link routing (cumora://auth#token=…) ==============
// Three entry points cover all three OSes:
//   • macOS (running) → `open-url` event
//   • macOS (cold start by Finder/Safari clicking the link) → `open-url` fires
//     after whenReady; we also stash the URL via `process.argv` as belt-and-braces
//   • Windows/Linux (running) → `second-instance` event (because we hold the
//     single-instance lock, a fresh `cumora cumora://…` invocation bounces here)
//   • Windows/Linux (cold start) → URL is in `process.argv` at boot
//
// Each handler funnels into dispatchAuthToken() which IPCs the renderer
// and brings the window to front — the same plumbing the (now-deprecated)
// loopback /auth/token POST used.
let pendingDeepLink = null

function consumeDeepLink(url) {
  const parsed = parseAuthDeepLink(url)
  if (!parsed) return
  // If main window hasn't loaded yet, dispatchAuthToken stashes the
  // payload in pendingAuthToken and the did-finish-load hook flushes
  // it. So we can call it eagerly here regardless of timing.
  dispatchAuthToken(parsed.token, parsed.companyId, parsed.nonce)
}

// macOS — single canonical event for all deep-link arrivals (running OR
// cold start). preventDefault stops Electron's default no-op.
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (!app.isReady()) { pendingDeepLink = url; return }
  consumeDeepLink(url)
})

// Windows / Linux — a second `cumora cumora://auth#…` invocation bounces
// here via the single-instance lock we acquired up top. The URL is the
// last element of argv per Electron convention.
app.on('second-instance', (_event, argv) => {
  const url = argv.find((a) => typeof a === 'string' && a.startsWith(DEEP_LINK_SCHEME + '://'))
  if (url) consumeDeepLink(url)
  // Always surface the existing window — the user just clicked something
  // expecting Cumora to come forward.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

// Windows / Linux cold-start path: the URL arrives baked into our own
// argv. macOS doesn't use argv for this — it uses open-url above.
{
  const coldStartUrl = process.argv.find((a) => typeof a === 'string' && a.startsWith(DEEP_LINK_SCHEME + '://'))
  if (coldStartUrl) pendingDeepLink = coldStartUrl
}

app.whenReady().then(() => {
  // Follow the OS so `prefers-color-scheme` in the renderer is honest.
  // The renderer sends `theme:set` when the user pins light or dark.
  // Previously this was forced to light on Darwin because the UI had
  // no dark palette.
  nativeTheme.themeSource = 'system'

  // Wire the app:// protocol handler. protocol.handle is the modern
  // API (Electron 25+) — gives us a streaming Response back so the
  // renderer never blocks on whole-bundle buffering. Anything we
  // can't resolve gets a 404. The handler ONLY serves packaged dist
  // content; appProtocolFile() rejects path-traversal attempts.
  protocol.handle('app', async (request) => {
    const file = appProtocolFile(request.url)
    if (!file) return new Response('not found', { status: 404 })
    try {
      return await net.fetch(pathToFileURL(file).toString())
    } catch (e) {
      console.warn('[app://]', request.url, '→', e?.message || e)
      return new Response('not found', { status: 404 })
    }
  })

  createWindow()
  // Notification window is no longer created at boot — it spawns on the
  // first `notification:push` IPC and self-destroys when the last toast
  // dismisses. See `notification:push` / `notification:set-interactive`.
  attachDisplayListeners()
  // System tray (menu bar item on macOS, system tray on Win/Linux).
  // Created after the main window so the `close → hide` interception
  // in createWindow already has its `tray` guard satisfied — no chance
  // of hiding to a non-existent tray.
  createTray()
  if (process.platform === 'darwin') {
    // Belt-and-suspenders: with `type: 'panel'` on the notification
    // BrowserWindow we should never lose the regular activation policy,
    // but the call is cheap so we keep it as a defensive measure.
    scheduleRegularDockRepair()
    try {
      const img = nativeImage.createFromPath(ICON_PATH)
      if (!img.isEmpty()) app.dock.setIcon(img)
    } catch (_) { /* swallow — dev convenience only */ }
    setDockUnreadDot(dockUnreadDotVisible)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
    }
  })

  if (isDev) registerDevShortcuts()
  startAuthLoopback()

  // Cold-start deep link (Windows/Linux, OR a macOS open-url that
  // arrived before whenReady resolved). consumeDeepLink stashes into
  // pendingAuthToken when the renderer isn't ready yet, and the
  // did-finish-load hook in createWindow flushes that.
  if (pendingDeepLink) {
    const url = pendingDeepLink
    pendingDeepLink = null
    consumeDeepLink(url)
  }

  // Wire auto-update. registerIpc() is safe to call even when
  // unsupported (handlers just return the unsupported status).
  // initialize() is a no-op when there's no update channel (e.g. dev
  // without dev-app-update.yml).
  autoUpdater.registerIpc()
  autoUpdater.setBeforeInstallHandler(() => {
    // electron-updater on macOS skips `before-quit` (it goes through
    // Browser::Shutdown), so our close-to-hide handler would otherwise
    // intercept the window close and the app would just hide instead of
    // exiting — Squirrel then waits forever for a quit that never comes
    // and the update never installs. Flip the flag now and tear down the
    // auxiliary windows / servers ourselves.
    appIsQuitting = true
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      try { notificationWindow.destroy() } catch { /* swallow */ }
      notificationWindow = null
    }
    if (authLoopbackServer) {
      try { authLoopbackServer.close() } catch { /* swallow */ }
      try { authLoopbackServer.closeAllConnections?.() } catch { /* swallow */ }
      authLoopbackServer = null
    }
    if (tray && !tray.isDestroyed?.()) {
      try { tray.destroy() } catch { /* swallow */ }
      tray = null
    }
  })
  autoUpdater.initialize()
})

// =============== Dev-only notification shortcuts ===============
// Inspired by Alma's debug menu. Press once to test the full pipeline
// (panel create → vibrancy → entry spring → chime → exit fade) without
// needing a real agent message round-trip.
//
//  - Cmd/Ctrl+Shift+N → single canned toast, cycles through samples
//  - Cmd/Ctrl+Shift+M → burst of 3 toasts from different convos (test
//                       the stack + per-toast chime)
const DEV_SAMPLES = [
  { authorId: 'iris-a0ab', authorName: 'Iris', conversationTitle: '设计评审', body: 'Mock-up #3 已经发出去了，回头看一眼。' },
  { authorId: 'atlas-dd9c', authorName: 'Atlas', conversationTitle: 'Strategy', body: 'Got the metrics breakdown ready. Tl;dr: Q3 looks fine, Q4 is the question.' },
  { authorId: 'bram-0154', authorName: 'Bram', conversationTitle: 'Engineering', body: '把那个 race condition 修了，已经合到 main。' },
  { authorId: 'nova-6596', authorName: 'Nova', conversationTitle: 'PM check-in', body: 'Quick ping — can you look at the v2 spec when you have a sec?' },
  { authorId: 'saga', authorName: 'Saga', conversationTitle: 'Direct', body: 'I have a draft of the storyboard. Want to see it now or after standup?' },
]
let devSampleIdx = 0
function makeDevPayload(sample) {
  const at = Date.now()
  return {
    id: `dev-${at}-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: `dev-${sample.authorId}`,
    authorId: sample.authorId,
    authorName: sample.authorName,
    authorAvatarUrl: null,
    conversationTitle: sample.conversationTitle,
    body: sample.body,
    at,
  }
}
function registerDevShortcuts() {
  const single = 'CommandOrControl+Shift+N'
  const burst = 'CommandOrControl+Shift+M'
  const okSingle = globalShortcut.register(single, () => {
    const s = DEV_SAMPLES[devSampleIdx % DEV_SAMPLES.length]
    devSampleIdx += 1
    pushNotification(makeDevPayload(s))
  })
  const okBurst = globalShortcut.register(burst, () => {
    // Three different conversations so the renderer treats them as
    // separate toasts (rather than coalescing). Slight stagger so the
    // spring entrance reads as a cascade, not a snap.
    for (let i = 0; i < 3; i++) {
      const s = DEV_SAMPLES[(devSampleIdx + i) % DEV_SAMPLES.length]
      setTimeout(() => pushNotification(makeDevPayload(s)), i * 160)
    }
    devSampleIdx += 3
  })
  console.log(`[dev-shortcuts] ${single}=${okSingle ? 'ok' : 'failed'}, ${burst}=${okBurst ? 'ok' : 'failed'}`)
}

// macOS: Dock-icon click (and Cmd-Tab to a hidden app) fires `activate`.
// Without this handler the app sits in the Dock with no way back —
// `window-all-closed` keeps the process alive but never re-shows or
// re-creates the window.
app.on('activate', () => {
  scheduleRegularDockRepair()
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Pre-quit cleanup. Without this Cmd-Q on macOS could hang and force
// users to Activity-Monitor-kill the process, because:
//  1. `notificationWindow` is `closable: false`; Electron's quit
//     sequence calls `close()` on every window — which is a no-op for a
//     non-closable window, leaving it alive and blocking `will-quit`.
//     `destroy()` bypasses the flag and the close handlers, so the
//     window goes away regardless.
//  2. The auth loopback HTTP server keeps a listening TCP socket open
//     on 127.0.0.1:47823 indefinitely. The Node event loop won't exit
//     while a server is listening, so even after all windows are gone
//     the process can sit forever.
app.on('before-quit', () => {
  // Flip the close-to-hide guard so the main window's `close` handler
  // lets the close actually happen during real quit (Cmd-Q, tray menu
  // Quit, window-all-closed on Win/Linux). Without this, every quit
  // path would just hide the window forever.
  appIsQuitting = true
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    try { notificationWindow.destroy() } catch { /* swallow */ }
    notificationWindow = null
  }
  if (authLoopbackServer) {
    try { authLoopbackServer.close() } catch { /* swallow */ }
    // closeAllConnections is Node 18+ — without it, keep-alive HTTP
    // clients can hold the port past app exit.
    try { authLoopbackServer.closeAllConnections?.() } catch { /* swallow */ }
    authLoopbackServer = null
  }
  if (tray && !tray.isDestroyed?.()) {
    try { tray.destroy() } catch { /* swallow */ }
    tray = null
  }
})

app.on('will-quit', () => {
  // Release the global accelerators so a zombie dev process doesn't
  // keep them claimed and shadow a fresh `pnpm electron:dev` from
  // registering them on next launch.
  globalShortcut.unregisterAll()
})

// Graceful shutdown on signals — primarily for dev where Ctrl-C in the
// terminal that ran `pnpm electron:dev` propagates SIGINT to children.
// Without this Electron ignores the signal and concurrently can't tear
// down vite + server.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { app.quit() } catch { /* swallow */ } })
}
