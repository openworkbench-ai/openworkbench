## Why

Today the agent can only author **brand-new** apps: it always plans a fresh manifest with a freshly minted `app.id` and freshly minted stable ids, and it ships only the built `dist/` bundle — the editable frontend source (`src/`) never leaves the agent's ephemeral scratch dir. So a user who wants to change an app they already deployed has no path: re-running the agent mints a *new* app id (the backend Bootstraps a duplicate, orphaning the original's data), and even for the same id there is no editable frontend source to start from — only minified build output.

The data-preserving redeploy machinery (`build.Deploy`, the stable-id-matched migration engine) and the job-versioned build-artifact + activation spine already exist on the backend. This change makes the editable frontend **source** a durable, versioned artifact of each deploy (riding that same spine), exposes a read seam to fetch an app's current manifest + source, and wires the agent to target an existing app, edit it in place, and redeploy as a true update.

## What Changes

- **Persist frontend source as a build artifact.** The `/deploy` ingest gains an optional `source` part (a gzipped tar of the editable scaffold — `src/` + build config, minus `node_modules`/`dist`). The backend stores it next to the served bundle under `apps/<id>/sources/<jobID>/`, keyed by the **same jobID** and pinned by the **same activation pointer** as the build. It is pruned on the same tail-retention as builds, and the backend **never executes or builds it** — it is stored only to be handed back on export.
- **Add a read seam.** A `GET` endpoint returns an already-registered app's current manifest and a gzipped tar of the **active** build's stored source, plus a signal of whether source was present.
- **Target an existing app from the agent.** The CLI accepts an existing app id (e.g. `--app <app_id>`); the orchestrator fetches that app's manifest + source over the read seam and seeds the planning/build sessions from it instead of a blank slate.
- **Preserve ids on update.** The planner edits the fetched manifest in place, keeping `app.id` and every entity/field **stable id**, so the redeploy is matched by stable id (a rename moves no data, an added field is a safe additive migration) rather than a new-app install.
- **Edit the real frontend.** The builder is seeded with the fetched source (not a blank scaffold) and edits it against the regenerated typed client; the submitter now also tars `src/` so the edited source is persisted on redeploy.
- **Graceful fallback.** When an app has no stored source (deployed before this change), export says so and the agent regenerates the frontend from the manifest. The optional `source` part keeps the existing default (stub/local) flow byte-for-byte unchanged.
- On submit, the agent redeploys through the **existing** `POST /deploy` path; the preserved app id routes it to `build.Deploy` (update), not `build.Bootstrap` (install).

## Capabilities

### New Capabilities
- `frontend-source-store`: The backend persists each deploy's editable frontend source as an immutable, job-versioned artifact (`apps/<id>/sources/<jobID>/`) pinned by the existing activation pointer and pruned with builds; it is stored opaquely and never executed.
- `app-source-export`: A read-only backend HTTP endpoint that returns a registered app's current manifest and a tar of the active build's stored source — the source of truth an external client edits to update the app — signaling when no source is on file.
- `agent-app-update`: The agent-side update flow — CLI targets an existing app id, the orchestrator/planner/builder seed from the fetched manifest + source and edit them in place preserving app id and stable ids, then redeploy through the existing `/deploy` seam (the submitter now also ships `src/`).

### Modified Capabilities
- `agent-deploy-ingest`: `POST /deploy` accepts an additional **optional** `source` multipart part, contained by the same extraction guards as `bundle`, and routes it to the frontend-source store. Absence is allowed (existing requirements and the default flow are otherwise unchanged).

## Impact

- **New code**: backend source-store (sibling to `build/frontend.go`'s artifact handling, sharing the activation pointer + prune); export endpoint (alongside `deployapi/`, reading registry + `active_builds` + the stored source); agent `--app` flag, an `AppSourceFetcher` seam (HTTP, selected like the submitter), and orchestrator/planner/builder plumbing.
- **Affected code**: `agent/src/cli.ts`, `orchestrator.ts`, `planner.ts`, `builder.ts`, `seams/submitter.ts` (also tar `src/`) + new fetcher + `select.ts`; `deployapi/multipart.go` + `deployapi.go` (parse/route `source`); `build/` (store + retrieve source, extend deploy/bootstrap), `cmd/pocketknife/main.go` (mount export route).
- **Unchanged invariants**: the migration engine's stable-id matching; the manifest validation hard gate; "Pocketknife does not bundle on-box" (source is never built server-side — the agent remains the only builder); the default no-`--app` new-app flow.
- **Security note**: the export endpoint exposes manifest + source; like `/deploy` it is currently unauthenticated — the same deliberate, separately-tracked gap, called out here, not solved.
