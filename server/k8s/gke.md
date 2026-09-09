# Deploying cumora on GKE

This is the step-by-step for getting `cumora-server` running on
Google Kubernetes Engine with Cloud SQL for PostgreSQL and
Memorystore for Redis. The end state matches what we verified in
OrbStack locally — server in K8s, per-agent Pods on-demand,
FUSE-backed workspace via the cumora-fuse → /runtime/fs/* path.

Variables you'll fill in (replace `REPLACE-*` placeholders as you go). The
values shown are the ones production actually uses — note that the cluster is
**zonal**, so every `gcloud container clusters …` call takes `--location`
(a zone), not `--region`:

```
PROJECT=cumora                  # GCP project id
REGION=us-west2                 # region for Cloud SQL / Memorystore / AR
LOCATION=us-west2-a             # ZONE of the cluster (see --location below)
CLUSTER=cumora-prod-z
AR_REPO=cumora                  # Artifact Registry repository
SQL_INSTANCE=cumora-pg          # Cloud SQL instance name
SQL_DB=cumora                   # database within the instance
SQL_USER=cumora                 # PG user
REDIS_INSTANCE=cumora-redis     # Memorystore instance
```

---

## 1. Cluster + image registry

```sh
# Standard GKE cluster with Workload Identity enabled.
# --location takes a zone for a zonal cluster, a region for a regional one.
gcloud container clusters create $CLUSTER \
  --location $LOCATION \
  --workload-pool=$PROJECT.svc.id.goog \
  --release-channel regular \
  --num-nodes 2

gcloud container clusters get-credentials $CLUSTER --location $LOCATION
```

Push the two cumora images to **Artifact Registry** — this is what
`build.yml` and `deploy.yml` use, and what production runs (use git sha or
semver, NOT `:dev`):

```sh
TAG=$(git rev-parse --short HEAD)
AR=$REGION-docker.pkg.dev/$PROJECT/$AR_REPO

gcloud auth configure-docker $REGION-docker.pkg.dev

docker build -f server/docker/cumora-server.Dockerfile \
  -t $AR/server:$TAG .
docker push $AR/server:$TAG

node server/src/scripts/build-agent-bundle.mjs
docker build -f server/docker/agent-computer.Dockerfile \
  -t $AR/agent-computer:$TAG .
docker push $AR/agent-computer:$TAG
```

> Older revisions of this guide pushed to `quay.io/yetoneful/cumora-*`. That
> path is legacy: nothing in CI or production reads it any more.

Substitute `REPLACE-TAG` in `cumora-server.gke.yaml` with `$TAG`.

When a change touches either the runtime API contract or
`server/docker/agent-computer-cumora.sh`, deploy `cumora-server` and
`cumora-agent-computer` from the same git sha. The in-pod `cumora` shim and
`/runtime/cli` response shape are coupled; a server-only rollout can leave
already-spawned agent pods unable to report typed CLI side effects until their
image is refreshed.

### Agent pod image: Chromium + OpenCLI

The agent-computer image bundles Chromium + Xvfb + the OpenCLI browser-
bridge extension so agents can drive a real browser. Per-agent PVCs
(`<podname>-chrome`, default 500Mi) hold Chromium's profile so cookies
and login state survive pod restarts. PVC size + StorageClass tune via
`CUMORA_CHROME_PVC_SIZE` and `CUMORA_CHROME_PVC_STORAGECLASS`.

Inspect a running agent's Chromium for debugging:

```sh
kubectl port-forward agent-<id> 9222:9222   # CDP endpoint
# then open chrome://inspect on your laptop with the network target
# pointed at localhost:9222
```

To wipe a permanently off-boarded agent's PVC, call the orchestrator's
`deleteChromeProfilePvc(agentId)` helper. The normal idle-exit path
deliberately leaves the PVC bound so the next pod re-uses it.

GKE nodes pull from Artifact Registry with their default service account, so
no `imagePullSecrets` are needed. If you are resurrecting the legacy quay.io
path instead, you'll also need the `quay-pull` secret described in step 4.

## 2. Cloud SQL + Memorystore

```sh
# PostgreSQL
gcloud sql instances create $SQL_INSTANCE \
  --database-version=POSTGRES_15 \
  --region=$REGION \
  --tier=db-f1-micro                # bump for prod load

gcloud sql databases create $SQL_DB --instance=$SQL_INSTANCE
gcloud sql users create $SQL_USER --instance=$SQL_INSTANCE \
  --password="$(openssl rand -base64 32 | tr -d '/+' | head -c 24)"

# Take note of the instance connection name:
gcloud sql instances describe $SQL_INSTANCE --format='value(connectionName)'
# Format: PROJECT:REGION:INSTANCE  — paste into cumora-server.gke.yaml

# Enable pgvector
gcloud sql instances patch $SQL_INSTANCE \
  --database-flags=cloudsql.enable_pgvector=on
# Then run, once, after migrations succeed:
#   CREATE EXTENSION vector;

# Redis (Memorystore)
gcloud redis instances create $REDIS_INSTANCE \
  --size=1 --region=$REGION
# Get the host: it'll be a private IP in your VPC.
gcloud redis instances describe $REDIS_INSTANCE --region=$REGION --format='value(host)'
```

## 3. Workload Identity binding

GKE Workload Identity lets the cumora-server K8s ServiceAccount act
as a GCP IAM service account without managing key files. The Cloud
SQL Proxy sidecar uses this.

```sh
GSA=cumora-server@$PROJECT.iam.gserviceaccount.com

# 1. Create the GCP service account
gcloud iam service-accounts create cumora-server --project=$PROJECT

# 2. Grant Cloud SQL Client (and any other GCP APIs cumora needs)
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$GSA" \
  --role="roles/cloudsql.client"

# 3. Bind K8s SA → GCP SA
gcloud iam service-accounts add-iam-policy-binding $GSA \
  --member="serviceAccount:$PROJECT.svc.id.goog[default/cumora-server]" \
  --role="roles/iam.workloadIdentityUser"
```

Paste `cumora-server@$PROJECT.iam.gserviceaccount.com` into the
`iam.gke.io/gcp-service-account` annotation in cumora-server.gke.yaml.

## 4. Secrets

```sh
# The cumora app secret (DATABASE_URL points at the Cloud SQL Proxy
# sidecar at 127.0.0.1:5432, which is in the SAME pod network ns
# as the server container).
kubectl create secret generic cumora \
  --from-literal=DATABASE_URL="postgres://$SQL_USER:PASSWORD@127.0.0.1:5432/$SQL_DB" \
  --from-literal=REDIS_URL="redis://REDIS_PRIVATE_IP:6379" \
  --from-literal=OPENAI_API_KEY="sk-..." \
  --from-literal=AGENT_RUNTIME_SECRET="$(openssl rand -hex 32)"

# Not needed on the Artifact Registry path above. Only for the legacy
# quay.io registry, and only if you also set QUAY_USER / QUAY_PASSWORD:
# kubectl create secret docker-registry quay-pull \
#   --docker-server=quay.io \
#   --docker-username=$QUAY_USER \
#   --docker-password="$QUAY_PASSWORD"
```

## 5. Generic Device Plugin (for FUSE)

Agent pods mount `/workspace` via FUSE; cumora-fuse needs
`/dev/fuse` access. Same plugin as on OrbStack:

```sh
kubectl apply -f https://raw.githubusercontent.com/squat/generic-device-plugin/main/manifests/generic-device-plugin.yaml

# Prod override: agent pods are FUSE-backed, so advertise enough
# /dev/fuse slots for bursts.
kubectl patch daemonset generic-device-plugin -n kube-system --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/containers/0/args/5","value":"name: fuse\ngroups:\n  - count: 800\n    paths:\n      - path: /dev/fuse\n"}]'
```

Verify the node advertises the resource:
```sh
kubectl describe node <any-node> | grep devic.es/fuse
# Allocatable: devic.es/fuse: 800
```

The server also applies an app-level `AGENT_POD_ADMISSION_MAX`
ceiling (default `40`) before creating agent pods. Keep that lower
than the advertised FUSE count so bursts are bounded by Cumora's real
CPU, memory, API-server, and provider concurrency budget.

> **The cluster-wide FUSE ceiling is inert under the shipped RBAC.**
> `getClusterFuseUtilization()` shells out to `kubectl get nodes`, and when
> that call fails it fails *open* — the cap becomes `Infinity`. Neither
> `cumora-server.gke.yaml` nor `cumora-server.orbstack.yaml` grants node reads:
> they bind a namespaced `Role` over `pods`, `pods/log`, and
> `persistentvolumeclaims` only. Until a `ClusterRole` +
> `ClusterRoleBinding` for `nodes: [get, list]` is added, only
> `AGENT_POD_ADMISSION_MAX` actually bounds admission.

On **GKE Autopilot**: the agent Pod needs the checked-in FUSE capability
envelope and `AppArmor: Unconfined` for the mount phase. If Autopilot rejects
that envelope, use a GKE **Standard** node pool or stop the agent deployment;
do not silently change the Pod to `privileged: true` or claim that a restricted
profile preserves the FUSE contract.

## 6. Agent policy and runtime security prerequisites

The agent image and Pod use a short trusted bootstrap phase. The Pod starts
`/usr/local/bin/cumora-agent-bootstrap` as UID/GID `0:0` with the exact
bootstrap capability set `SYS_ADMIN, SETUID, SETGID, SETPCAP, KILL`; its
container and Pod templates drop `ALL`, use `RuntimeDefault` seccomp, disable
service-account-token mounting, and set `fsGroup: 65532`. The bootstrap must
mount FUSE, verify readiness, then exec the demoted supervisor. Long-lived
Node, browser, Xvfb, OpenCLI, and PID 1 processes must be UID/GID `65532:65532`
with empty capability sets and `NoNewPrivs=1`; `allowPrivilegeEscalation: false`
and `SYS_ADMIN` in the initial template do not prove that post-bootstrap state.
AppArmor remains `Unconfined` because GKE's default profile blocks the FUSE
mount syscall. This is a FUSE prerequisite, not a claim that the Pod is
restricted during the mount phase.

Pre-deploy the policy bundle in the exact namespace configured by
`CUMORA_AGENT_NAMESPACE` and before waking any managed agent:

```sh
AGENT_NS=default                 # must equal the server Deployment env
kubectl apply -n "$AGENT_NS" -f server/k8s/cumora-agent-network-policy.yaml
kubectl get networkpolicy -n "$AGENT_NS" \
  cumora-agent-default-deny cumora-agent-egress
```

The server Role only has `get/list/watch` on `networkpolicies`; the agent Pod
does not receive the projected Kubernetes API token and cannot mutate policy.
That setting does not by itself suppress GCP Workload Identity or metadata
credentials; those require separate runtime, CNI, and operator controls. The
orchestrator checks the actual objects, labels, selectors, policy version,
DNS/server ports, and public Web
CIDR exclusions before creating or reusing a Pod. Missing or malformed policy
objects fail closed. Both policies select only `app=cumora-agent`; the
default-deny object therefore leaves server, Redis, and other namespace Pods
outside its scope. The bundle permits DNS UDP/TCP 53, the trusted
`kubernetes.io/metadata.name` namespace plus `app=cumora-server` on TCP 5181,
and public TCP 80/443. Set `CUMORA_AGENT_SERVER_NAMESPACE` to the namespace
whose `app=cumora-server` Pods are trusted, and update the server namespace
selector in the policy bundle when that namespace differs from the agent
namespace. IPv4 RFC1918, CGNAT, loopback, link-local, metadata,
documentation, multicast, and reserved ranges are excluded. IPv6 excludes
loopback, ULA/private, link-local, multicast, and documentation ranges.
There is no automatic exception for `OPENAI_BASE_URL`, model URLs, or other
per-user configuration; an operator exception must be an explicit reviewed
NetworkPolicy change.

NetworkPolicy objects are additive, enforcement is asynchronous, and a cluster
without a NetworkPolicy-capable CNI ignores these manifests. Before enabling
agents, verify the CNI's NetworkPolicy support and test from an ephemeral
agent-like Pod in this namespace: DNS works, the server service on 5181 works,
public HTTPS works, and RFC1918/metadata destinations fail. `kubectl apply`
success alone is not enforcement evidence. This repository has no claim that
OrbStack or this workstation has verified production CNI behavior.

## 7. Existing Pods and Chrome PVC migration

The orchestrator reuses a Running/Pending Pod only after parsing its live API
object and matching the security profile label, exact bootstrap command and
image, root bootstrap identity, capability set, seccomp/AppArmor, token
automount setting, and `fsGroup`. A legacy or unknown Pod is deleted and
confirmed absent with a bounded wait before a replacement is created; a timeout
fails closed. It preserves the existing namespace, placement, tenant, capacity
checks, and Chrome PVC. It never starts a second Pod with the same agent name
while the old immutable object remains.

The UID change leaves existing Chrome PVC data in place. Kubernetes storage
drivers may apply `fsGroup` at mount time, but hostPath/local drivers often do
not. For each existing PVC, first verify in the configured agent namespace
that the mounted profile is readable and writable by UID/GID `65532:65532` and
that Chromium can open the old profile. If the driver does not honor fsGroup,
use a reviewed, offline operator migration that preserves the PVC and backup;
do not recursively `chown` attacker-writable profile data in the bootstrap,
delete the PVC, clear cookies, or move it to another namespace. A failed
permission check must stop the rollout until the storage migration is done.

For a manual upgrade, inspect one old Pod and PVC first, delete only that Pod,
wait for its name to disappear, then let the next wake create the new template:

```sh
kubectl get pod -n "$AGENT_NS" agent-<id> -o yaml
kubectl get pvc -n "$AGENT_NS" agent-<id>-chrome -o yaml
kubectl delete pod -n "$AGENT_NS" agent-<id> --wait=true --timeout=30s
kubectl wait -n "$AGENT_NS" --for=delete pod/agent-<id> --timeout=60s
```

Do not run a production-wide cleanup as part of this change. Roll out one
agent, verify FUSE/browser/runtime and PVC behavior, then proceed using the
normal capacity and placement controls.

## 8. Apply the manifest

After replacing `REPLACE-*` placeholders in
`server/k8s/cumora-server.gke.yaml`:

```sh
# For a manual installation, run the candidate image's migration command once
# against the same DATABASE_URL before starting application replicas. The
# production Deploy workflow creates and verifies this one-shot Job for you;
# it captures a create-only Deployment recovery record before that Job and
# restores an exact template only after the old image proves read-only schema
# compatibility.
npm run migrate
kubectl apply -f server/k8s/cumora-server.gke.yaml
kubectl rollout status deployment/cumora-server
```

The application Pods only read `schema_migrations` and refuse to start outside
their supported version range. They never execute DDL during startup.

The checked-in manifest gives the server a startup grace window for the
schema gate: `/api/livez` is checked every 5 seconds with a 60-failure budget
(about 5 minutes). Once startup succeeds, liveness continues to use the
DB-free `/api/livez` process check while readiness uses `/api/health` to keep a
pod out of rotation when its dependencies are unavailable. The production
Deploy workflow reapplies the same probe contract during its Pod-template
patch, so a manual `kubectl apply` does not require a follow-up imperative
probe patch.

## 9. Verify end-to-end

```sh
# Server pods running, both 2/2 containers ready
kubectl get pod -l app=cumora-server

# Fire a wake event into Redis (port-forward to test)
kubectl port-forward svc/cumora-server 5181:5181 &
# from another shell — publish a fake message.new
# (or send a real user message via the API endpoint)

# Watch an agent pod spin up
kubectl get pod -l app=cumora-agent -w

# Inspect a running agent
kubectl logs agent-<id>
```

## What to keep in mind

- **Cluster-internal DNS in the Deployment env** —
  `AGENT_RUNTIME_SERVER_URL` uses `cumora-server.default.svc.cluster.local`.
  Change `default` if you deploy to a different namespace.
- **Agent pod namespace** — `CUMORA_AGENT_NAMESPACE` env on the
  server container picks where agent pods land. For prod separate
  them into a dedicated namespace (e.g. `cumora-agents`) and
  duplicate the Role + RoleBinding scoped there.
- **Image upgrades** — tag both images with the same git sha;
  redeploy by updating both the server Deployment image and
  `CUMORA_AGENT_COMPUTER_IMAGE` to the same tag. The Deploy workflow runs one
  candidate migration Job before mutating the Deployment. Production resolves
  both to immutable `@sha256:` digests and uses a JSON Patch UID/template CAS;
  mutable tags, unknown image sources, and template drift are refused.
- **PG schema changes** — append an immutable version and checksum; never edit
  an applied migration. Use expand/contract changes that remain compatible with
  the old server version still serving during the rolling-update window. A
  rollout timeout or smoke failure may recover only when the captured old image
  reports the current ledger inside its own supported range through the
  independent read-only verifier. Unknown or newer schema history requires a
  forward-compatible image or reviewed repair; it is never treated as proof
  that an arbitrary old image can start.
- **Idle scheduler** — runs in-process on EACH server replica.
  That's fine because idle's tick currently publishes to
  CH_MESSAGE_NEW which SETNX-dedups; only one replica handles
  each tick's downstream work.
- **Monitoring** — both Pods (server + agent) log to stdout/stderr
  which GKE auto-collects to Cloud Logging. Set up alerting on
  agent_runs.status='failed' or kubelet's container_restart_count.
