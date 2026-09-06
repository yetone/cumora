# Workload Identity Federation — one-time setup

GitHub Actions authenticates to GCP without any long-lived service-account
key. Instead, GitHub mints a short-lived OIDC token, and a Workload Identity
Pool maps it to a real GCP service account. **GCP authentication** needs only
two values, both stored as repo secrets:

- `GCP_WIF_PROVIDER` — the full Workload Identity Provider resource name
- `GCP_DEPLOY_SA` — the email of the GCP service account GH Actions impersonates

The Deploy workflow has two further prerequisites beyond GCP auth:

- Repo secrets `CUMORA_SMOKE_TOKEN` and `CUMORA_SMOKE_COMPANY_ID`, used by the
  post-rollout authenticated smoke check that gates automatic rollback
- A GitHub **environment** named `production` (`deploy.yml` declares
  `environment: production`), which supplies the independent approval step

Run the steps below **once**, in your terminal (not in CI).

```sh
PROJECT=cumora
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
POOL=github-pool
PROVIDER=github-provider
REPO=yetone/cumora                  # owner/name as it appears on github.com
SA=cumora-ci@$PROJECT.iam.gserviceaccount.com

# 1. Create the service account GH Actions will impersonate.
gcloud iam service-accounts create cumora-ci --project=$PROJECT \
  --display-name="Cumora CI/CD"

# 2. Grant it the minimal roles it needs:
#    - artifactregistry.writer: push images to AR
#    - container.developer: kubectl get pods / set image / rollout status
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role="roles/container.developer"

# 3. Create the Workload Identity Pool + Provider.
gcloud iam workload-identity-pools create $POOL \
  --location=global --project=$PROJECT \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc $PROVIDER \
  --location=global --workload-identity-pool=$POOL --project=$PROJECT \
  --display-name="GitHub" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == '$REPO'"

# 4. Let GH Actions tokens from this repo impersonate the SA.
gcloud iam service-accounts add-iam-policy-binding $SA \
  --project=$PROJECT \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO"

# 5. Print the two repo-secret values:
echo "GCP_WIF_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
echo "GCP_DEPLOY_SA=$SA"
```

### Add the two outputs as GitHub repo secrets

```sh
gh secret set GCP_WIF_PROVIDER --repo $REPO \
  --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
gh secret set GCP_DEPLOY_SA --repo $REPO --body "$SA"
```

Or do it via the web UI: https://github.com/yetone/cumora/settings/secrets/actions

### Once that's set up

- Every push to `main` triggers the Build workflow → images appear in AR
- Deploy is **always** a manual dispatch: GitHub → Actions → Deploy → Run
  workflow → pick a tag. `deploy.yml` has no `push` trigger at all, by design —
  a bad commit on `main` must not auto-ship to prod.
- Pushing a `v*` tag fires the **Release** workflow only (the Electron desktop
  hand-off to `yetone/cumora-releases`). It does not touch GKE.

### Tightening later

The `attribute-condition` above restricts to the cumora repo. To restrict
further to only main-branch pushes (so a feature branch can't dispatch
Deploy), add `attribute.ref` to the condition:

```
--attribute-condition="assertion.repository == '$REPO' && assertion.ref == 'refs/heads/main'"
```

But you lose `workflow_dispatch` from arbitrary branches. Personal preference.
