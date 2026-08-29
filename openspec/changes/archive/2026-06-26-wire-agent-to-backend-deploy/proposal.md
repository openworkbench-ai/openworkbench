## Why

The agent (`agent/`) plans a manifest and builds a frontend bundle, but its one irreversible step — `submit()` — only writes the result to `agent/out/<jobId>/`. The Go backend can serve apps from `apps/<app_id>/` but has no way to receive one from outside. The two halves are designed to meet (the `HttpSubmitter` / `VALIDATE_MODE=http` seams already exist as stubs that throw), but the wire between them was never built. The result: an approved app never reaches the running server, so it is never reachable at `/ui/<app_id>/`.

This change builds that wire. On approval, the agent POSTs the manifest plus the built bundle to a new backend ingest endpoint, which installs and activates the app live — so a freshly approved app is immediately reachable.

## What Changes

- **New backend ingest endpoint** (`POST /deploy`) that accepts a manifest plus a frontend bundle keyed on `jobId`, writes them into `apps/<app_id>/`, and installs/activates the app through the existing build pipeline so it is served at `/ui/<app_id>/` with no restart.
- **First-install path for a brand-new app**: today `build.Deploy` only operates on an already-registered app. The endpoint adds the missing step — create the app directory + manifest + bundle on disk, open the store, materialize DDL, and register the app live — then activates the frontend. An already-existing app id routes through the existing `build.Deploy` (install/redeploy) path.
- **Implement `HttpSubmitter`** in the agent (`agent/src/seams/submitter.ts`) to replace the throwing stub: a multipart POST of the manifest + a gzipped tar of the built `dist/`, idempotency-keyed on `jobId`, returning the deployed `appId` and reachable URL.
- **Wire the manifest's `frontend` pointer**: the ingest endpoint ensures the stored manifest's `frontend.dist` / `frontend.entry` point at the bundle it just wrote, so `build.buildFrontend` finds it.
- The transport seam (`SUBMIT_MODE=http`, `GO_BASE_URL`) stays the single switch; `SUBMIT_MODE=stub` remains the default so existing local flows are unchanged.

## Capabilities

### New Capabilities
- `agent-deploy-ingest`: the backend HTTP contract for receiving an approved app (manifest + built bundle) keyed on a job id, installing/activating it through the build pipeline, and reporting the reachable URL — including the first-install path that registers a brand-new app live.

### Modified Capabilities
<!-- No existing capability spec changes its requirements: build/activation, migration, and stable-id storage keep their current contracts; this change consumes them. -->

## Impact

- **New code**: a backend ingest handler (new package or an extension of `build/`), mounted in `cmd/pocketknife/main.go` alongside `/apps/`, `/builds/`, `/ui/`, `/validate`.
- **Agent**: `agent/src/seams/submitter.ts` (`HttpSubmitter`), unchanged `select.ts` seam; `.env.example` documents `SUBMIT_MODE=http` + `GO_BASE_URL`.
- **Reuses unchanged**: `build.Deploy` / `build.buildFrontend` (pre-built bundle on disk), `validate.Manifest` (hard gate), `materialize` (DDL), `registry.Register` (live registration), `assets.NewServer` (per-request resolution → instant reachability).
- **Out of scope**: authentication/authorization on the ingest endpoint (control-plane security is a separate concern), and replacing `StubSubmitter` (kept as the default).
