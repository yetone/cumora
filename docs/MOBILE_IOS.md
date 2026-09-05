# Cumora Mobile — iOS build & App Store submission

This document walks the end-to-end flow for building, testing and
submitting the Cumora iOS app via Capacitor. It assumes a clean macOS
machine with Xcode 15+. There is no Podfile and no CocoaPods step — native
dependencies are Swift Package Manager packages, resolved into
`ios/App/CapApp-SPM/Package.swift` by `npx cap sync ios`.

## Architecture summary

- **Renderer**: the same Vite/React bundle that ships in Electron
  (`src/`). Mobile vs desktop is chosen by `useIsMobile()` in
  `src/lib/utils.ts`. On iOS/Android, Capacitor's native bridge sets
  `window.Capacitor.isNativePlatform()` to `true`, which forces the
  mobile shell regardless of viewport size (handles iPad split-view).
- **Native shell**: Capacitor 8.x. Config lives in
  `capacitor.config.ts`. Plugins wired through `src/lib/native.ts`:
  status bar, splash screen, keyboard, app (back button), haptics.
- **Backend**: same API as the desktop app — the committed
  `.env.production` sets `VITE_CUMORA_API_BASE=https://api.cumora.ai`,
  so the bundled WKWebView talks to prod. Point it at your own
  deployment when self-hosting.

## One-time setup

```bash
# Install Capacitor plugin packages declared in package.json.
npm install

# The native iOS project (./ios/App) is already committed — do NOT run
# `npx cap add ios` on a fresh checkout.

# Generate App Icon + Splash assets from build/icon.png.
# `sharp` is required just for this script — install transient.
npm install --no-save sharp
node scripts-gen-ios-assets.mjs

# Build the web bundle, then copy assets and resolve native plugins.
# `mobile:sync` is `npm run build && npx cap sync` — no platform
# argument, so it syncs BOTH ios/ and android/.
npm run mobile:sync
```

## Day-to-day development

```bash
# Iterate against a live web bundle in the simulator. Capacitor will
# load index.html from the bundled dist/ — for hot reload point
# server.url at your laptop's LAN IP (NOT checked in).
npm run mobile:ios:run
```

To run against a remote dev API, temporarily **add** a `server.url` to
capacitor.config.ts (it is deliberately absent from the checked-in config —
don't commit one) or set `cumora.serverUrl` via localStorage in the in-WebView
devtools.

## Release build for App Store / TestFlight

1. **Check the production API endpoint** — the committed
   `.env.production` must point `VITE_CUMORA_API_BASE` at the API this
   build should talk to.

2. **Bump the version.** `Info.plist` reads `$(MARKETING_VERSION)` /
   `$(CURRENT_PROJECT_VERSION)`, so bump those two settings in
   `ios/App/App.xcodeproj/project.pbxproj` — each appears in both the
   Debug and Release configuration blocks. Every App Store Connect
   upload needs a unique (version, build) tuple; Apple rejects
   duplicates.

3. **Build and sync**:

   ```bash
   npm run mobile:sync
   ```

4. **Open in Xcode**:

   ```bash
   npx cap open ios
   ```

5. In Xcode:
   - Select the **App** target → **Signing & Capabilities**: pick
     your Apple Developer team. Bundle identifier should be
     `io.cumora.app` (matches `capacitor.config.ts`). Note the
     committed Release config uses **manual signing** with a
     pre-created distribution cert + profile; on a fork, switch the
     Release config to your own team (automatic signing is fine
     for a first build).
   - Verify the App Icon set is `AppIcon` and the launch storyboard
     uses the generated Splash image.
   - **Product → Archive**. When the Organizer opens, choose
     **Distribute App → App Store Connect** → **Upload**.

6. In App Store Connect, attach the build to a new version, fill in
   the privacy/encryption answers, attach the screenshots described
   below, and submit for review.

## Required Info.plist keys

`ios/App/App/Info.plist` already declares the four keys App Review needs:

```xml
<key>NSCameraUsageDescription</key>
<string>Cumora uses the camera to share photos in conversations.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>Cumora needs access to your photo library to attach images to messages.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Cumora can record short voice notes for your conversations.</string>
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

The one key **not** present is `NSUserTrackingUsageDescription`. Only add it
if the app actually calls App Tracking Transparency — today it doesn't, and
declaring a permission you don't use is itself a rejection reason:

```xml
<key>NSUserTrackingUsageDescription</key>
<string>Cumora does not track you across other apps and websites.</string>
```

Likewise, drop the camera/photo/mic strings if those features stop shipping.

## App Store screenshots — required sizes

Apple currently requires:

| Device class                 | Pixels         | Notes                              |
|------------------------------|----------------|------------------------------------|
| 6.9" iPhone (15/16 Pro Max)  | 1290 × 2796    | Required for all iPhone-only apps  |
| 6.5" iPhone (XS Max)         | 1284 × 2778    | Optional fallback if 6.9" present  |
| 12.9" iPad Pro (3rd gen+)    | 2048 × 2732    | Required if app supports iPad      |

Use the iOS simulator: Device → 16 Pro Max, then Cmd+S in each of the
app's main tabs to capture a screenshot per surface. Save them anywhere
convenient (they are not tracked in the repo) and upload via
App Store Connect.

## Privacy — App Privacy questionnaire

Cumora collects the following per-user data (be explicit when answering
the questionnaire):

| Category              | Items                  | Linked to user | Tracking | Reason             |
|-----------------------|------------------------|----------------|----------|--------------------|
| Contact Info          | Name, email            | Yes            | No       | Account            |
| User Content          | Messages, attachments  | Yes            | No       | App Functionality  |
| Identifiers           | User ID                | Yes            | No       | Account            |
| Usage Data            | Product Interaction    | Yes            | No       | Analytics (PostHog)|
| Diagnostics           | Crash data             | No             | No       | App Functionality  |

PostHog is the only third-party SDK and is keyed off the
`VITE_PUBLIC_POSTHOG_KEY` env. If the key is omitted at build time,
PostHog is not initialised — declare it conditional in the App Store
listing.

## Known mobile gaps tracked as follow-up work

- **Convene tab**: shows an intentional empty state until the
  workspace-wide active-sessions endpoint lands. Triggering a Convene
  from a conversation header still works.
- **MobileMe → Status**: removed pending a backend presence API.
  Resurface as a Status row once `setSelfStatus` exists server-side.
- **Voice / camera capture**: composer attachment picker uses the
  generic file input. To get a native sheet, add
  `@capacitor/camera` and branch on `isNativePlatform()` in the
  picker.

Push notifications, once on this list, have shipped end-to-end — see
[PUSH_NOTIFICATIONS.md](./PUSH_NOTIFICATIONS.md).

## Validating the build before upload

```bash
# Sanity check the web bundle that ships inside the .ipa.
npm run typecheck
npm run build

# Capacitor doctor — verifies plugin versions and native config.
npx cap doctor ios
```

If `cap doctor` flags unresolved native dependencies, re-run
`npx cap sync ios` and let Xcode resolve the Swift packages
(File → Packages → Resolve Package Versions). There is no `pod install`
step in this project.
