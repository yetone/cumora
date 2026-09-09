# Release Manual

How to cut a new desktop release of Cumora.

## TL;DR

```bash
# 1. Bump the version in package.json
npm version patch       # → 0.1.0 → 0.1.1   (creates the tag locally)

# 2. Push the tag — GitHub Actions does the rest
git push origin main --tags
```

The push to a `v*` tag fires the desktop release workflow:

- **`.github/workflows/release.yml`** in this repo → dispatches to
  `yetone/cumora-releases`, which builds + signs + publishes the
  Electron app for macOS (arm64 + Intel), Windows, and Linux. Final
  artifacts land at https://github.com/yetone/cumora-releases/releases.

It does **not** deploy the API server. Backend production deploys are an
explicit, separately approved action; a desktop tag must never silently mutate
the backend.

The auto-updater in the desktop app reads from `https://updates.cumora.ai`
(the R2-backed `generic` feed), with the `cumora-releases` GitHub Release as a
fallback. Once the release workflow finishes (~15–20 minutes) and the R2 mirror
step has run, running clients will pick it up on their next periodic update
check.

## Backend release: build candidate, then ignite production

Every push to `main` runs `.github/workflows/build.yml`. Before publishing an
image it must pass both TypeScript projects, the big-brain and tracked-LLM
guards, unit tests, and the Postgres/Redis integration suite. A successful run
produces immutable SHA-tagged server (and, when affected, agent-computer)
images. It does not deploy them.

To deploy a candidate:

1. Open **Actions → Deploy → Run workflow**.
2. Enter the exact short SHA tag produced by Build. Avoid `latest` when a SHA
   is available; Deploy resolves either tag to a digest before touching GKE.
3. Set `include_agent=Y` when the build changed `server/src/agents/**`, the
   bundled CLI/runtime, or the agent-computer image. Otherwise use `N`.
   Leave `repair_0002=off` unless you are clearing the migration 0002
   precondition — see below.
4. Approve the protected `production` environment. The approver should not be
   the person who built the feature for high-risk changes.
5. Verify the workflow summary contains the selected digest, a completed
   rollout, and passed authenticated smoke. If the candidate fails, the
   workflow remains red even when guarded recovery restores the previous
   template successfully.

The normal workflow requires the captured Deployment to have an observed,
fully available rollout and a passing core baseline smoke. When that baseline
is known to be unhealthy, an approver may explicitly choose
`recovery_mode=forward-only` in the workflow dispatch. That mode still captures
the UID/template, runs the candidate migration and CAS patch, and requires the
candidate rollout plus strict Shipping smoke. It never runs automatic restore
after a candidate rollout or smoke failure; the failed state is handled by a
forward-compatible deployment plan.

Deploy first proves that the existing production API and smoke credential are
healthy, captures the complete Deployment Pod template and UID in an immutable
create-only recovery Secret, runs one candidate-image migration Job, updates
the server (and optionally agent runtime) by digest with an atomic
compare-and-swap patch, waits for GKE, then exercises real authenticated tenant
paths: auth, conversations, and the Shipping overview/schema. A migration
failure leaves the Deployment untouched and retains the Job for inspection.
The baseline and restored-template smoke checks cover the core authenticated
paths; the candidate success check additionally requires Shipping overview and
schema.

The recovery path never uses `kubectl rollout undo`. Any failed rollout status
or smoke failure first checks that the UID and exact candidate template still match the
protected receipt. It then runs the captured old server image in an independent
read-only schema verifier Job. The verifier imports its own `pool.ts`,
`schema-version.ts`, and migration manifest, runs `BEGIN READ ONLY` with a
30-second statement timeout, and must emit one valid compatibility marker. A
missing module, timeout, malformed output, unknown schema, or template drift
refuses recovery and leaves the candidate state for forward repair. Only a
compatible result restores the exact captured template, waits for rollout, and
runs authenticated smoke again. Recovery success is evidence for operators;
the candidate workflow still fails.

The baseline and candidate receipt Secrets contain Pod-template state and are
immutable. Do not print, upload, or copy their contents. A retry reads and
validates the original baseline instead of replacing it. Cancellation can skip
cleanup, so inspect retained migration/verifier Jobs and the protected records
before deleting anything.

### Backend recovery runbook

The release path classifies a failed candidate as follows:

- **Same schema:** the old image's read-only verifier reports its current
  ledger version inside that image's exact supported range. If the candidate
  template has not drifted, the workflow restores the captured server/agent
  images, probes, environment, mounts, and security context atomically, then
  proves rollout and authenticated smoke.
- **Newer or damaged schema:** the old verifier returns a known incompatible
  result. Automatic restoration is refused. Keep the migration Job and
  protected receipt, stop further deploy attempts, and use a forward-compatible
  image or an explicit database repair plan. Lowering an image's MIN bound or
  silently accepting an unknown migration is unsafe.
- **Unknown compatibility:** missing old-image modules, a verifier timeout,
  connection/cleanup error, a non-unique marker, invalid JSON, or any extra
  unexpected output is treated as unknown. Do not restore automatically.
- **Restore or smoke failure:** a failed JSON Patch CAS, rollout, or restored
  smoke leaves the workflow failed and requires manual forward recovery. Check
  the Deployment UID/template hash and controller events before a new run.

The checked-in helper has an explicit recovery-only entry point. It does not
capture a new baseline, run a migration, or patch a candidate before the
compatibility check:

```sh
export KUBECTL=kubectl
export DEPLOYMENT=cumora-server
export DEPLOYMENT_NAMESPACE=default
export RECOVERY_SECRET='cumora-deploy-recovery-<run-id>'
export RECEIPT_SECRET='cumora-deploy-recovery-<run-id>-receipt'
export RECOVERY_WORKDIR=/tmp/cumora-manual-recovery
export VERIFIER_JOB_NAME="cumora-schema-verify-manual-$(date -u +%Y%m%d%H%M%S)"
export CUMORA_SMOKE_TOKEN='(read from the protected operator environment)'
export CUMORA_SMOKE_COMPANY_ID='(read from the protected operator environment)'
export CUMORA_SMOKE_BASE=https://api.cumora.ai
node --import tsx scripts/deploy-release.mjs recover
```

Use the exact protected Secret names from the failed run and run this from a
checkout with the same helper. The command reads and validates the immutable
baseline and candidate receipt, blocks on active migration Jobs, runs the old
server image's read-only verifier under the fresh `VERIFIER_JOB_NAME`, then performs the UID/template CAS restore,
rollout, and authenticated smoke. It never runs migration or accepts a
mutable image. A missing baseline/receipt, active Job, schema incompatibility,
unknown verifier result, or CAS drift returns a stable failure code and leaves
the current Deployment unchanged. Inspect completed Jobs and their proxy state
before retrying; do not delete an active Job to force a new result.

If the receipt is missing or compatibility is unknown, use the explicit
forward-only workflow mode: choose an image whose own manifest explicitly
supports the current ledger, review any migration/expand-contract repair
separately, and dispatch `Deploy` with `recovery_mode=forward-only`. Do not
manufacture a baseline or lower the old image's supported minimum. Manual
recovery success still belongs to the failed candidate incident; run a new
reviewed forward deployment before marking the release successful.

#### When migration 0002 refuses to apply

Migration 0002 normalizes conversation membership (ADR 0004) and fails closed
when a `conversations.members` entry names an id with no participant in that
conversation's tenant. The Job log carries a precheck report first — counts by
category plus a masked sample — so read that before doing anything.

These entries predate the tenant guard in `startPulledGroup` and grant nothing
today: every read path is tenant-scoped, so a foreign member id is unreachable
membership, and ADR 0004's composite FK cannot represent it at all. Rerunning
Deploy with `repair_0002=archive-detach` lets 0002 clear its own precondition:

- every offending `(conversation, member)` pair is copied into
  `conversation_members_detached_0002` — with its ordinal *and* the whole
  pre-detach members array — before it is removed;
- `messages` is never touched, so an archived member that posted in the
  conversation keeps its authorship;
- the precheck re-runs afterwards, so anything a detach cannot fix (a
  conversation with no `company_id`, say) still stops the deploy;
- all of it runs inside 0002's transaction, so any later failure rolls the
  detach back with it.

The archive is a complete record, not a one-click undo. Once 0002 has applied,
its projection trigger enforces ADR 0004 on every write, so putting a detached
id back into `conversations.members` fails until that id is a real participant
in that tenant — which is the invariant the migration exists to establish. What
the archive gives you is the ability to see exactly what was removed and from
where:

```sql
SELECT conversation_id, member_id, ordinal, authored_messages,
       participant_elsewhere, original_members
  FROM conversation_members_detached_0002
 ORDER BY conversation_id, ordinal;
```

A genuine restore means first making the id resolvable (recreate or move the
participant into that tenant), then re-adding it through `addConversationMember`.
`original_members` records the exact pre-detach array to restore against.

`repair_0002` applies to that one run only — it is passed as an explicit
container `env` entry that overrides the `cumora` Secret, and defaults to
`off`, so an ordinary deploy keeps failing closed.

Shipping features additionally track a production readback deadline, default
24 hours after a successful release. The Ship workspace surfaces due items;
the server turns missed deadlines into `overdue` release state plus high
severity friction. `.github/workflows/production-readback.yml` independently
checks authenticated production paths each day. A feature only reaches
`Learned` after its production release has explicit readback evidence and no
failing regression asset.

### Required backend secrets and environment protection

On `yetone/cumora`:

| Name | Purpose |
|------|---------|
| `GCP_WIF_PROVIDER` | Workload Identity Federation provider used to resolve and deploy images. |
| `GCP_DEPLOY_SA` | Least-privilege service account for Artifact Registry and the production GKE deployment. |
| `CUMORA_SMOKE_TOKEN` | Dedicated, revocable session/service token used only for authenticated smoke/readback. |
| `CUMORA_SMOKE_COMPANY_ID` | Non-sensitive tenant id that the smoke identity belongs to. |

Protect the `production` GitHub environment with required reviewers. Put the
smoke secrets in both `production` and `production-readback` (or configure the
latter to inherit repository secrets). Rotate the smoke token like any other
production credential and never print it in workflow output.

## What the release workflow does

1. Matrix-builds the Electron app on four runners (macOS arm64,
   macOS Intel, Windows, Linux).
2. On macOS, imports the Developer ID cert into a temporary keychain,
   signs the app bundle, and notarises via the Apple credentials in
   GitHub Secrets.
3. Uploads platform-specific artifacts (DMG, ZIP, EXE, AppImage, DEB,
   `latest*.yml` autoupdate feeds, blockmaps).
4. Merges the per-arch `latest-mac.yml` files so one feed advertises
   both arm64 and Intel.
5. Generates a user-friendly changelog via the OpenAI API from the
   commit list between the previous tag and this one.
6. Mirrors everything to the `cumora-updates` Cloudflare R2 bucket
   (only when R2 secrets are configured — optional).
7. Creates the GitHub Release with the artifacts attached and the
   generated changelog as the body.
8. Posts an announcement to the Discord release channel (only when the
   webhook is configured — optional).

## One-time setup (already done; reference only)

### Required GitHub Secrets

On `yetone/cumora`:

| Name | Purpose |
|------|---------|
| `RELEASES_REPO_TOKEN` | Fine-grained PAT scoped to `yetone/cumora-releases`. Needs `Actions: write`. |

On `yetone/cumora-releases`:

| Name | Purpose |
|------|---------|
| `CUMORA_REPO_TOKEN`             | Fine-grained PAT scoped to `yetone/cumora`. Needs `Contents: read`. |
| `MAC_CERTIFICATE_P12`           | Base64-encoded Developer ID Application cert (`.p12`). `base64 -i Certificates.p12 \| pbcopy`. |
| `MAC_CERTIFICATE_PASSWORD`      | Password protecting the `.p12` above. |
| `APPLE_ID`                      | Apple Developer account email. |
| `APPLE_APP_SPECIFIC_PASSWORD`   | App-specific password for notarisation. Generated at appleid.apple.com → Sign-In and Security → App-Specific Passwords. |
| `APPLE_TEAM_ID`                 | 10-char Team ID from developer.apple.com → Account → Membership. |
| `OPENAI_API_KEY`                | Used to generate the changelog. |
| `R2_ACCESS_KEY_ID`              | (optional) R2 mirror for the `cumora-updates` bucket. |
| `R2_SECRET_ACCESS_KEY`          | (optional) R2 mirror credential. |
| `CLOUDFLARE_ACCOUNT_ID`         | (optional) R2 endpoint scope. |
| `DISCORD_RELEASE_WEBHOOK_URL`   | (optional) Discord channel webhook for release announcements. |

If any of the optional secrets are unset, the workflow skips that step
and still succeeds.

### One-time Cumora-side wiring

- `build.publish` in `package.json` is an **ordered array**: the first entry
  is the `generic` feed at `https://updates.cumora.ai` (R2-backed) and is what
  electron-updater actually polls; the `github` entry for
  `yetone/cumora-releases` is the fallback feed. See `electron/autoUpdater.cjs`.
- `build.mac.notarize` is `true`; electron-builder picks up `APPLE_TEAM_ID`
  (alongside `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD`) from the workflow
  environment.
- `build/entitlements.mac.plist` declares the hardened-runtime
  entitlements Electron needs (JIT, network access, dyld vars).

## Releasing the `cumora` CLI to npm

The BYOA daemon users install with `npx cumora@latest` is a **separate**
artifact from the desktop app: the npm package `cumora`, built from
`agent-cli/`. It has its own workflow and is not part of a `v*` tag release.

`.github/workflows/publish.yml` publishes it on any push to `main` that
touches `agent-cli/**` — typically the `chore(agent-cli): release cumora@X`
version bump in `agent-cli/package.json`. To cut a CLI release:

```bash
# Bump agent-cli/package.json's own "version", then merge to main.
# The workflow runs `node build.mjs` and `npm publish --access public`.
```

Notes:

- It publishes only if that exact version isn't already on the registry, so
  re-pushing `main` is a no-op rather than a failure.
- It needs the repo secret `NPM_TOKEN` (an npm **automation** token, which
  bypasses 2FA for writes). Until that secret exists the workflow no-ops
  cleanly instead of failing.
- `agent-cli/package.json`'s version is independent of the root
  `package.json` version. Keep them in step by convention, not by tooling.

## Manual rebuild of a past release

If a previous release needs a re-roll (signing failed, missing artifact,
etc.), use the `workflow_dispatch` form on `yetone/cumora-releases`:

1. Go to https://github.com/yetone/cumora-releases/actions/workflows/release.yml
2. **Run workflow** → enter:
   - `ref` = the tag from this repo (e.g. `v0.1.0`)
   - `version` = the bare version (e.g. `0.1.0`)
3. The workflow re-builds and overwrites the existing release artifacts.

## Common issues

- **macOS notarisation fails.** Most commonly `APPLE_APP_SPECIFIC_PASSWORD`
  was rotated or the cert is expired. Check
  `https://appleid.apple.com` and `Keychain Access` on a Mac with the
  cert installed.
- **Build runs but no GitHub Release is created.** The publish job
  requires `permissions: contents: write` which is already set in the
  workflow. If you forked the repos, make sure that permission is also
  granted on your fork.
- **`latest-mac.yml` mentions only one architecture.** One of the two
  Mac runners failed before producing the yml. Look at the `Upload
  build artifacts` step on `build-mac-arm64` / `build-mac-x64`.
- **The desktop app doesn't see the update.** The autoupdater checks 3
  seconds after launch and then every **30 minutes** (`electron/autoUpdater.cjs`
  sets that interval explicitly). Force it from the app menu or restart.
