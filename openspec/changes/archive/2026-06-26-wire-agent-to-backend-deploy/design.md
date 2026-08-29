## Context

The agent and backend were built to meet at a seam that was never closed:

- Agent side (`agent/`): `Orchestrator.submit()` is the one irreversible action, dispatched through the injected `Submitter` interface. `StubSubmitter` writes `out/<jobId>/{manifest.json, frontend/, bundle.json}`; `HttpSubmitter` exists but throws. `seams/select.ts` is the only place reading `SUBMIT_MODE` / `GO_BASE_URL`. The built static bundle lives at `<scratchDir>/dist/` (entry `index.html` + hashed assets).
- Backend side: `cmd/pocketknife/main.go` mounts `/apps/` (CRUD), `/builds/` (read-only status), `/ui/` (`assets.NewServer`, resolves the active bundle from the registry *per request*), `/validate`. `build.Deploy` builds + activates a **pre-built** bundle (`build.buildFrontend` only validates `fe.Dist` exists on disk and copies it into a versioned artifact dir — it does not bundle on-box). `registry.Register` adds/replaces an app live; `assets.NewServer` re-resolves per request, so a newly registered + activated app is reachable with no restart.

The gap is twofold: (1) there is no HTTP endpoint to receive a bundle, and (2) `build.Deploy` assumes the target app is **already registered** — there is no first-install path that creates the store, materializes DDL, and registers a brand-new app. The agent always produces new apps, so first-install is the core requirement.

## Goals / Non-Goals

**Goals:**
- A single backend endpoint that receives `{jobId, manifest, frontend bundle}` and lands the app reachable at `/ui/<app_id>/` with no restart.
- Reuse the existing hard gate (`validate.Manifest`), materialize, build/activation, and registry machinery rather than duplicating them.
- First-install (new app) **and** redeploy (existing app id) both work through one endpoint.
- Idempotent on `jobId`: a retried POST converges to the same result, never a duplicate or a corrupt half-write.
- Close the agent seam: `HttpSubmitter` posts the bundle and returns the deployed `appId` + reachable URL; `SUBMIT_MODE=stub` stays the default.

**Non-Goals:**
- Authentication / authorization on the endpoint (control-plane security is a separate change).
- Replacing `StubSubmitter` or changing the validate seam (`VALIDATE_MODE=http` stays as-is).
- On-box bundling — the agent ships the built `dist/`; the backend serves it verbatim, as `build.buildFrontend` already assumes.
- Streaming progress / websockets; the existing `/builds/` status routes cover observability.

## Decisions

### D1: Transport — multipart POST (`manifest` JSON part + gzipped tar of `dist/`)
`POST /deploy` with `Content-Type: multipart/form-data`:
- `jobId` — form field, the idempotency key.
- `manifest` — a part carrying the manifest JSON.
- `bundle` — a part carrying a gzipped tar of the built `dist/` tree (entry `index.html` + hashed assets).

Rationale: matches the comment already in `submitter.ts` ("multipart POST … idempotency-keyed on jobId"); a single tar part keeps an arbitrarily deep asset tree intact and avoids one-part-per-file fan-out. Tar entries are path-validated on extraction (reject `..` / absolute paths) so a malicious bundle cannot escape the app directory — mirroring the `scratch-guard` posture on the agent side.
*Alternative considered:* JSON body with base64 assets — rejected (bloats payload ~33%, awkward for binary assets). *Alternative:* raw `dist/` as many multipart parts — rejected (loses directory structure, fragile).

### D2: One endpoint, two internal paths keyed on "is this app id already registered?"
The handler validates the manifest first (hard gate, reusing `validate.Manifest`), then:
- **App id unknown → first-install path** (new code): create `apps/<app_id>/`, write `manifest.json` + extract the bundle to `apps/<app_id>/dist/`, `store.Open` the new `data.db`, `materialize` the DDL, `registry.Register` the app, then run the frontend build+activation (`build.Deploy` with `Kind=install`, or a thin install helper) to copy the bundle into a versioned artifact dir and promote it active.
- **App id known → redeploy path**: write the new bundle to `apps/<app_id>/dist/`, then call `build.Deploy` with the new manifest bytes — its existing logic decides install vs. data-migration deploy by version and carries the single rollback contract.

Rationale: the first-install path is the genuinely missing piece; everything after "app is registered" is exactly what `build.Deploy` already does. We extract the new-app bootstrap (store + materialize + register) into a small reusable helper that mirrors what `registry.Load` does for one app on boot, rather than forking `Deploy`.
*Alternative considered:* make `build.Deploy` itself handle the unknown-app case — rejected for now to keep `Deploy`'s rollback contract (which restores a *prior* good state) unentangled with the create-from-nothing case, whose failure mode is simply "delete the half-created app dir."

### D3: The backend owns the `frontend` pointer
The manifest the agent validates need not carry a `frontend` block. The ingest handler writes the bundle to `apps/<app_id>/dist/` and ensures the stored manifest's `frontend = {dist: "dist", entry: "index.html"}` (entry overridable by a multipart field) so `build.buildFrontend` finds it. This keeps the agent's manifest concerns (data schema) separate from the deploy-time bundle location.

### D3a: The bundle is mount-point-agnostic by construction — the backend does no path rewriting
The agent's Vite template (`agent/templates/frontend/vite.config.ts`) sets `base: "./"`, so the built `dist/` references its assets with relative URLs (`./assets/<hash>.js`). That is what lets the same bundle work served under `/ui/<app_id>/` without the backend rewriting any paths. The relevant backend behavior already exists: `assets.NewServer` 301-redirects `/ui/<app_id>` → `/ui/<app_id>/` so the trailing slash makes relative asset URLs resolve correctly, serves the tree verbatim, and SPA-falls-back to the entry file. The deploy wire therefore treats the bundle as opaque static files; it does **not** transform `index.html` or asset URLs. The ingest's only frontend obligation is to validate that the extracted bundle actually contains the entry file before activating. (Invariant to preserve agent-side: if the template's `base` ever moves away from `"./"`, or the builder overrides it, apps would break under `/ui/<app_id>/`.)

### D4: Idempotency + failure atomicity on `jobId`
The handler stages into a temp dir and the bundle into `apps/<app_id>/dist/` only after validation passes. For first-install, a failure deletes the freshly created app dir and leaves the registry untouched. For redeploy, `build.Deploy`'s existing snapshot/rollback contract owns atomicity. A repeated `jobId` that already produced a `StateReady` job returns that job's result without re-deploying (looked up via the platform db), so the agent can safely retry.

### D5: Response shape — reuse the error envelope; return the reachable URL
Success: `200 {"appId": "...", "version": N, "jobId": "...", "url": "/ui/<app_id>/"}`. Failure: the same `{"error": {"code","message"}}` envelope `build/http.go` and `api` already emit (validation failures → `422`/`400` with the error list, unknown/conflict → appropriate codes). `HttpSubmitter` maps `appId` + `url` back to the CLI line already printed today.

## Risks / Trade-offs

- **Untrusted tar extraction (path traversal / zip-bomb).** → Reject entries with `..`, absolute paths, or symlinks; cap total extracted bytes and file count (mirror the sandbox's byte-cap posture). Build only proceeds after extraction validates.
- **First-install partial failure leaves a stale app dir.** → Create under a temp name and rename into place on success; on any error, remove the temp dir; never `registry.Register` until store+materialize succeed.
- **Concurrent deploys of the same app id.** → Serialize per-app at the handler (a per-app lock, or rely on `build`'s job creation to reject an in-flight job). Document single-writer assumption; the platform db job state is the source of truth.
- **No auth on a state-changing endpoint.** → Explicitly out of scope here, but the endpoint must be trivially guardable later (single mount point, no side effects before validation). Flagged in Open Questions.
- **Manifest without a `frontend` block being force-fitted.** → If the manifest already declares a `frontend`, honor it; only inject the default pointer when absent, and validate the extracted bundle actually contains the entry file before activating.

## Migration Plan

1. Backend: add the ingest handler + first-install helper; mount `POST /deploy` in `main.go`. Pure addition — no existing route or contract changes, so deploying it is backward compatible.
2. Agent: implement `HttpSubmitter`; no change to `select.ts` or the default `SUBMIT_MODE=stub`. Document `SUBMIT_MODE=http` + `GO_BASE_URL` in `.env.example`.
3. Rollout: opt-in via `SUBMIT_MODE=http`. Rollback = unset it (agent falls back to `StubSubmitter`); the backend endpoint is inert when unused.

## Open Questions

- **Auth**: should `/deploy` require a shared secret / token from the start, given it mutates server state? (Leaning: add a simple bearer-token gate in a fast follow; keep this change auth-free but isolated.)
- **App-id collisions**: when the agent submits an app id that already exists from a *different* job, is that an intended redeploy or an accidental clobber? (Leaning: treat known id as redeploy via `build.Deploy`; revisit if the agent should mint unique ids.)
- **Retention of the on-disk `apps/<app_id>/dist/`** vs. the versioned `builds/<jobId>/` artifact — confirm the staging `dist/` can be pruned after activation since the served copy is the artifact dir.
