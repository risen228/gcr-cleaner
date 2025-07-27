# risenx/gcr-cleaner

Container that prunes old Docker image versions in **Google Artifact Registry** using a rule-based config. Any image matching **at least one** rule is kept; everything else is deleted.

---

## Quick Start

```bash
docker run --rm \
  -e GCLOUD_PROJECT_ID=my-project \
  -e GCLOUD_REGISTRY_REGION=europe-west1 \
  -e GCLOUD_REGISTRY_REPOSITORY=my-repo \
  -e GCLOUD_SERVICE_ACCOUNT_KEY="$(cat key.json)" \
  -e CLEANUP_RULES_JSON='[
    {"type":"latest"},
    {"type":"prefixTimestamp","prefix":"dev-","keep":2},
    {"type":"semver","keep":2,"includePrerelease":false}
  ]' \
  -e REQUESTS_PER_MINUTE=30 \
  risenx/gcr-cleaner
````

### Cloud Run (scheduled)

1. Deploy the service:

   ```bash
   gcloud run deploy gcr-cleaner \
     --image=risenx/gcr-cleaner \
     --region=europe-west1 \
     --set-env-vars=GCLOUD_PROJECT_ID=my-project,GCLOUD_REGISTRY_REGION=europe-west1,GCLOUD_REGISTRY_REPOSITORY=my-repo,REQUESTS_PER_MINUTE=30 \
     --set-env-vars=CLEANUP_RULES_JSON='[{"type":"latest"},{"type":"prefixTimestamp","prefix":"dev-","keep":2},{"type":"semver","keep":2,"includePrerelease":false}]' \
     --set-secrets=GCLOUD_SERVICE_ACCOUNT_KEY=projects/123/secrets/cleanup-sa-key:latest \
     --no-allow-unauthenticated
   ```
2. Trigger periodically via Cloud Scheduler (HTTP POST to the service URL) or run as a Cloud Run Job on a schedule.

---

## Environment Variables

| Variable                     | Required | Description                                                |
| ---------------------------- | -------- | ---------------------------------------------------------- |
| `GCLOUD_PROJECT_ID`          | yes      | GCP project ID                                             |
| `GCLOUD_REGISTRY_REGION`     | yes      | Artifact Registry region (e.g. `europe-west1`)             |
| `GCLOUD_REGISTRY_REPOSITORY` | yes      | Repository name                                            |
| `GCLOUD_SERVICE_ACCOUNT_KEY` | no\*     | SA key JSON string (omit if using ADC / Workload Identity) |
| `CLEANUP_RULES_JSON`         | no       | JSON array of rules (defaults applied if missing)          |
| `REQUESTS_PER_MINUTE`        | no       | Delete calls per minute (default: 30)                      |
| `DRY_RUN`                    | no       | `1` to log deletions without executing                     |

\* Needed when not using native GCP auth.

---

## Rules (`CLEANUP_RULES_JSON`)

Array of objects. `keep` = number of images per path to retain for that rule.

**Supported types:**

* `latest` — keep images tagged `latest`.

  ```json
  { "type": "latest" }
  ```

* `semver` — keep top `keep` semver-tagged images.

  * `includePrerelease`: include all pre-releases.
  * `prerelease`: only this prerelease channel (e.g. `"beta"`), overrides `includePrerelease`.

  ```json
  { "type": "semver", "keep": 2, "includePrerelease": false }
  { "type": "semver", "keep": 2, "prerelease": "beta" }
  ```

* `prefixTimestamp` — keep images with tags like `dev-<timestamp>` (or any custom regex with one numeric capture group).

  * `prefix`: e.g. `"dev-"`
  * `regex`: optional custom regex

  ```json
  { "type": "prefixTimestamp", "prefix": "dev-", "keep": 2 }
  { "type": "prefixTimestamp", "regex": "^build-(\\d{14})$", "keep": 3 }
  ```

* `recent` — keep everything uploaded within the last `ms` milliseconds.

  ```json
  { "type": "recent", "ms": 3600000 }
  ```

### Example (initial requirements)

```json
[
  { "type": "latest" },
  { "type": "prefixTimestamp", "prefix": "dev-", "keep": 2 },
  { "type": "semver", "keep": 2, "includePrerelease": false }
]
```

*Add another `semver` rule with `"prerelease":"beta"` to keep 2 additional beta builds if needed.*

---

## IAM Permissions

Create and bind a minimal custom role to the cleaner’s service account. Pulumi example:

```ts
const cleanupAdminRole = new gcp.projects.IAMCustomRole(
  "cleanup-admin-role",
  {
    roleId: "cleanupAdmin",
    title: "Cleanup Admin",
    description: "A custom role for cleanup",
    permissions: [
      "artifactregistry.repositories.get",
      "artifactregistry.repositories.list",
      "artifactregistry.dockerimages.list",
      "artifactregistry.packages.delete",
      "artifactregistry.packages.get",
      "artifactregistry.packages.list",
      "artifactregistry.tags.get",
      "artifactregistry.tags.list",
      "artifactregistry.tags.delete",
      "artifactregistry.versions.delete",
      "artifactregistry.versions.list",
      "artifactregistry.versions.get"
    ],
  },
  { parent: this },
)
```

---

## Dry Run

```bash
docker run --rm -e DRY_RUN=1 ... risenx/gcr-cleaner
```

---

## Common Issues

* **403 Permission denied** → grant the role above to the SA.
* **Invalid JSON** → `CLEANUP_RULES_JSON` malformed.
* **Nothing deleted** → rules too permissive; lower `keep` or refine filters.
* **Quota/Rate limits** → reduce `REQUESTS_PER_MINUTE` or batch runs.
