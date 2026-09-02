# Deploying cumora on GKE

This is the step-by-step for getting `cumora-server` running on
Google Kubernetes Engine with Cloud SQL for PostgreSQL and
Memorystore for Redis. The end state matches what we verified in
OrbStack locally — server in K8s, per-agent Pods on-demand,
FUSE-backed workspace via the cumora-fuse → /runtime/fs/* path.

Variables you'll fill in (replace `REPLACE-*` placeholders as you go):

```
PROJECT=your-gcp-project-id
REGION=us-central1
CLUSTER=cumora-prod
SQL_INSTANCE=cumora-pg          # Cloud SQL instance name
SQL_DB=cumora                   # database within the instance
SQL_USER=cumora                 # PG user
REDIS_INSTANCE=cumora-redis     # Memorystore instance
QUAY_USER=...                   # quay.io credentials (or use Artifact Registry)
```

---

## 1. Cluster + image registry

```sh
# Standard GKE cluster with Workload Identity enabled
gcloud container clusters create $CLUSTER \
  --region $REGION \
  --workload-pool=$PROJECT.svc.id.goog \
  --release-channel regular \
  --num-nodes 2

gcloud container clusters get-credentials $CLUSTER --region $REGION
```

Push the two cumora images (use git sha or semver, NOT `:dev`):

```sh
TAG=$(git rev-parse --short HEAD)

docker build -f server/docker/cumora-server.Dockerfile \
  -t quay.io/yetoneful/cumora-server:$TAG .
docker push quay.io/yetoneful/cumora-server:$TAG

node server/src/scripts/build-agent-bundle.mjs
docker build -f server/docker/agent-computer.Dockerfile \
  -t quay.io/yetoneful/cumora-agent-computer:$TAG .
docker push quay.io/yetoneful/cumora-agent-computer:$TAG
```

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

If using Artifact Registry instead of quay.io, push to
`$REGION-docker.pkg.dev/$PROJECT/cumora/...` and drop the
`imagePullSecrets` / quay-pull steps below (GKE nodes pull from AR
with their default service account automatically).

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

# Image pull secret for quay.io (skip if you switched to AR)
kubectl create secret docker-registry quay-pull \
  --docker-server=quay.io \
  --docker-username=$QUAY_USER \
  --docker-password="$QUAY_PASSWORD"
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

The server still applies an app-level `AGENT_POD_ADMISSION_MAX`
ceiling (default `200`) before creating agent pods. Keep that lower
than the advertised FUSE count so bursts are bounded by Cumora's real
CPU, memory, API-server, and provider concurrency budget.

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
