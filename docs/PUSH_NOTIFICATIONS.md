# Push notifications (iOS APNs + Android FCM)

Cumora's mobile clients deliver chat-message notifications when the app
is backgrounded or killed — iOS via APNs, Android via FCM. When
the app is foregrounded the in-app `NotificationToasts` stack handles
presentation instead — see `src/components/NotificationToasts.tsx`.

This doc covers the **manual setup** required outside the codebase: the
Apple Developer Portal / Firebase config plus the env vars the server
needs to actually send. Everything else (Capacitor plugin install,
AppDelegate forwarding, entitlements file, DB table, register/unregister
routes, APNs + FCM senders, WS bridge, client wiring, mute respect,
recipient calculation) is already in the repo.

## What's already in the codebase

| Surface | Location |
| --- | --- |
| `@capacitor/push-notifications` plugin | `package.json` + `ios/App/CapApp-SPM/Package.swift` (synced by `npx cap sync ios`) |
| AppDelegate APNs callbacks → Capacitor bridge | `ios/App/App/AppDelegate.swift` |
| `aps-environment` entitlement | `ios/App/App/App.Debug.entitlements` (development) + `ios/App/App/App.Release.entitlements` (production) — selected automatically by Xcode build config |
| `push_devices` table | `server/src/db/migrate.ts` |
| `POST /push/register` / `POST /push/unregister` | `server/src/api/router.ts` (near the bottom) |
| APNs sender (HTTP/2 + ES256 JWT, no third-party lib) | `server/src/push.ts` |
| FCM sender (HTTP v1, service-account JWT) | `server/src/fcm.ts` |
| Recipient filter (skips author, currently-online users, muted convos) | `computeMessageRecipients` in `server/src/push.ts` |
| Outbound dispatch on new message | `dispatchMessagePush` in `server/src/push.ts`, called from **both** POST `/conversations/:id/messages` (`server/src/api/router.ts`) and `cmdReply` (`server/src/agents/cli.ts`) — an agent's reply travels the second path only |
| Client lifecycle (request perms, register, deep-link, sign-out) | `src/lib/push.ts` + `src/mobile/MobileApp.tsx` + `src/mobile/MobileMe.tsx` |
| User preference `notify.push` (in-app kill switch) | `TOGGLE_PREFS` in `src/mobile/MobileMe.tsx` |

The server soft-disables push when APNs / FCM credentials are absent:
`/push/register` still accepts tokens (so the device side keeps working
when you later configure creds) but every send is a no-op that logs once
at boot.

## What you still have to do (Apple Developer Portal)

1. **Enable Push Notifications on the bundle id.**
   - developer.apple.com → Certificates, IDs & Profiles → Identifiers
   - Select `io.cumora.app` → check **Push Notifications** under
     Capabilities → **Save**.
2. **Mint an APNs Auth Key (`.p8`).**
   - developer.apple.com → Keys → **+** → name it "Cumora APNs" →
     check **Apple Push Notifications service (APNs)** → Continue → Register.
   - **Download the `.p8` once**. Apple will not let you download it again.
   - Record the **Key ID** shown on the keys list (10-char string).
3. **Find your Team ID.**
   - developer.apple.com → Membership → Team ID (10-char string).

## Server env vars

Drop the `.p8` somewhere the server process can read it (NOT in the
repo) and point the env vars at it.

### Local dev (`.env`)

```sh
APNS_KEY_PATH=/Users/<you>/.cumora-secrets/AuthKey_<KEY_ID>.p8
APNS_KEY_ID=<KEY_ID>                # the 10-char Key ID
APNS_TEAM_ID=<TEAM_ID>              # the 10-char Team ID
APNS_TOPIC=io.cumora.app            # matches the bundle id
APNS_ENV=development                # sandbox endpoint for Debug builds
```

### Production (GKE — see `server/k8s/cumora-server.gke.yaml` for a deployment template)

Two Secrets:

1. **`cumora`** — already exists. Append the four APNs scalars to it:
   ```sh
   kubectl get secret cumora -o json \
     | jq '.data["APNS_KEY_ID"]   |= "'$(echo -n "<KEY_ID>"   | base64)'"
         | .data["APNS_TEAM_ID"]  |= "'$(echo -n "<TEAM_ID>" | base64)'"
         | .data["APNS_TOPIC"]    |= "'$(echo -n "io.cumora.app" | base64)'"
         | .data["APNS_ENV"]      |= "'$(echo -n "production"  | base64)'"' \
     | kubectl apply -f -
   ```
   Or interactively: `kubectl edit secret cumora` and add the four base64-encoded keys.

2. **`cumora-apns-key`** — new, holds only the `.p8` file. Create with:
   ```sh
   kubectl create secret generic cumora-apns-key \
     --from-file=AuthKey_<KEY_ID>.p8=/path/to/AuthKey_<KEY_ID>.p8
   ```
   `server/k8s/cumora-server.gke.yaml` does **not** yet declare this volume —
   it only wires `envFrom: secretRef: {name: cumora}`. Add the volume and
   mount yourself, at `/var/run/secrets/cumora-apns/`, and set
   `APNS_KEY_PATH` to the mounted file. Mark the volume `optional: true` so
   pods still boot when the secret is absent — the push path soft-disables
   itself.

3. **Apply the deployment** to pick up the new volume mount:
   ```sh
   kubectl apply -f <your-deployment>.yaml
   kubectl rollout restart deployment/cumora-server
   ```

If you change the Key ID later, update `APNS_KEY_PATH` in your
deployment manifest to match the new filename inside the secret.

### Dev ↔ prod entitlement matching

The dev / prod split matters: **mismatched env + entitlement silently
400s every push.** This is wired automatically via two entitlements
files keyed off the Xcode build config:

| Xcode config | Entitlements file               | aps-environment | APNS_ENV     |
| ------------ | ------------------------------- | --------------- | ------------ |
| Debug        | `ios/App/App/App.Debug.entitlements`   | `development`  | `development` |
| Release      | `ios/App/App/App.Release.entitlements` | `production`   | `production`  |

Use Debug builds for Simulator / device-attached development; Release
for TestFlight + App Store. The single APNs Auth Key created above
(scope: "Sandbox & Production") works for both endpoints — no extra
key needed at App Store submission.

## Android (FCM)

The Android path mirrors iOS with a different sender: the same
`@capacitor/push-notifications` plugin registers an FCM token
(`platform='android'` in `push_devices`), and the server sends via the
FCM HTTP v1 API (`server/src/fcm.ts`) authenticated with a Firebase
service account — set `FCM_SERVICE_ACCOUNT_JSON` (inline JSON) or
`FCM_SERVICE_ACCOUNT_PATH`. The Android client build additionally needs
your own `android/app/google-services.json` — copy
`android/app/google-services.json.example` and fill in your Firebase
project's values. Absent credentials soft-disable FCM sends exactly
like APNs.

## End-to-end test

1. `npm run server:dev` — server logs `[push] APNs credentials not
   configured` once if env vars are absent; otherwise nothing on the
   happy path.
2. `npm run mobile:ios:run` — launches the app in the simulator. iOS
   simulators **cannot receive APNs pushes** unless you're on Xcode 14+
   with the simulator push API; for true end-to-end use a physical
   device on a debug build.
3. After signing in on the device, iOS prompts for notification
   permission once. Grant it. The device shows up in `push_devices`:
   ```sql
   SELECT id, user_id, platform, last_seen_at, disabled_at FROM push_devices;
   ```
4. From another device / account, send the user a message. The push
   should land within ~1s. Tap it → app opens to that conversation.

## When pushes don't fire

| Symptom | Likely cause |
| --- | --- |
| Permission prompt never appears | Capacitor's `Push Notifications` plugin didn't sync — re-run `npx cap sync ios` |
| `register()` rejects, no device-token row | `aps-environment` entitlement missing or mismatched (Debug ↔ development) |
| Server logs "APNs credentials not configured" | env vars unset; `/push/register` still works but sends are no-op |
| 403 from APNs (DeviceTokenNotForTopic) | `APNS_TOPIC` doesn't match the bundle id |
| 410 / device disabled | Expected; `push_devices.disabled_at` is set. Re-install or sign back in to re-register |
| Foreground app shows OS banner instead of in-app toast | Expected only when the app is backgrounded. Foreground deliveries fall through to `NotificationToasts`. |
| Push fires for a user looking at the chat | Their `participants.status` is not `'avail'` — check WS connectivity. The server suppresses pushes only for users marked `'avail'` |
| Flipped `notify.push` on but nothing arrives | The toggle only writes the preference. Unregistration/registration happens on the next `initPushNotifications` call — tap **Re-register** in You → Push status, or background and re-foreground the app (`installVisibilityHook` in `src/lib/push.ts` retries when there's no token). No relaunch needed |

## Open items (deliberate)

- **Doc-mention pushes / calendar reminder pushes.** Both already have
  WS events (`doc.mention`, `calendar.reminder`); wiring them into
  `notifyMessage`-style senders is a follow-up.
