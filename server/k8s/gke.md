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

On **GKE Autopilot**: the plugin DaemonSet works but Autopilot may
reject `securityContext.capabilities.add: [SYS_ADMIN]` depending on
admission policy. If so, switch to **GKE Standard**, OR fall back
to `privileged: true` (Autopilot allows it for explicit workloads
with extra annotations — read the Autopilot security docs).

## 6. Apply the manifest

After replacing `REPLACE-*` placeholders in
`server/k8s/cumora-server.gke.yaml`:

```sh
# For a manual installation, run the candidate image's migration command once
# against the same DATABASE_URL before starting application replicas. The
# production Deploy workflow creates and verifies this one-shot Job for you.
npm run migrate
kubectl apply -f server/k8s/cumora-server.gke.yaml
kubectl rollout status deployment/cumora-server
```

The application Pods only read `schema_migrations` and refuse to start outside
their supported version range. They never execute DDL during startup.

> **Patch the liveness probe after applying.** The checked-in manifest still
> points `livenessProbe` at `/api/health`, which touches the database. The
> Deploy workflow patches it to `/api/livez` on every rollout precisely
> because a DB-backed liveness probe turned a connection-pool stall into a
> restart loop (2026-05-27). A manual `kubectl apply` re-introduces the bad
> config, so follow it with:
>
> ```sh
> kubectl patch deployment/cumora-server --type=json -p='[{
>   "op": "replace",
>   "path": "/spec/template/spec/containers/0/livenessProbe/httpGet/path",
>   "value": "/api/livez"
> }]'
> ```
>
> Readiness should stay on `/api/health` — that one *should* pull a pod out of
> rotation when its dependencies are gone.

## 7. Verify end-to-end

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
  candidate migration Job before mutating the Deployment.
- **PG schema changes** — append an immutable version and checksum; never edit
  an applied migration. Use expand/contract changes that remain compatible with
  the old server version still serving during the rolling-update window.
- **Idle scheduler** — runs in-process on EACH server replica.
  That's fine because idle's tick currently publishes to
  CH_MESSAGE_NEW which SETNX-dedups; only one replica handles
  each tick's downstream work.
- **Monitoring** — both Pods (server + agent) log to stdout/stderr
  which GKE auto-collects to Cloud Logging. Set up alerting on
  agent_runs.status='failed' or kubelet's container_restart_count.
