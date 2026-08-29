## 1. Typed client generator

- [x] 1.1 Create `client` package; `Generate(*schema.App) ([]byte, error)` as a pure function
      of the validated schema model, no Go-struct or hand-maintained-interface reflection
- [x] 1.2 Emit a shared preamble once (`ApiError`, `ListResult`, `request()`, `buildQuery()`)
      matching the generic API's URL scheme, query syntax, JSON shapes and error envelope
- [x] 1.3 Per entity: row type (platform columns + declared fields in manifest order), Create
      input type, Update input type, filterable/sortable field union — all gated by which
      operations the entity allows
- [x] 1.4 Per entity: client class exposing exactly the CRUD/list methods the manifest enables;
      root client composing every entity client
- [x] 1.5 Tests: determinism (byte-identical regeneration), disabled-operation omission,
      required-field-with-default optional-on-create, reference field id-typing

## 2. Build-job state machine and platform database

- [x] 2.1 Create `build` package; `Store` over a platform-level SQLite db (`platform.db`),
      wholly separate from any app's `data.db`
- [x] 2.2 `build_jobs` table (id, app id, kind, manifest version, state, error, asset dir,
      timestamps) and `active_builds` table (one row per app: job id, asset dir, manifest
      version, updated at)
- [x] 2.3 `State` (queued/building/activating/ready/failed) and the enforced
      `allowedTransitions` map: failed from every working state, ready/failed terminal
- [x] 2.4 `CreateJob`, `Transition` (rejects disallowed moves via `ErrInvalidTransition`),
      `SetAssetDir`, `Get`, `ListForApp`, `InFlightJobs`, `PromoteActive`, `ActiveBuildFor`
- [x] 2.5 Tests: every allowed transition, every disallowed transition rejected and state
      unchanged, retry creates a new job rather than reopening a failed one

## 3. Install build and activation

- [x] 3.1 `Deploy` derives `Kind` (install vs deploy) by comparing the incoming manifest's
      version against the app's currently-registered schema version
- [x] 3.2 `buildFrontend`: copies a manifest's declared `Frontend.Dist` into
      `apps/<id>/builds/<job-id>/`, never overwriting a previous job's directory
- [x] 3.3 Activation cutover: durable `active_builds` pointer and in-memory registry
      `AssetDir` updated together, only after the new artifact is fully on disk
- [x] 3.4 `pruneOldBuilds`: retains the most recent `DefaultBuildRetention` (5) artifact
      directories per app by modification time, run only after a successful cutover
- [x] 3.5 Tests: first install activates and serves the real frontend; a broken build (bad
      `Frontend.Dist` path) fails legibly to `StateFailed` with a diagnosable error and leaves
      no partial artifact; retry after fixing the source succeeds independently

## 4. Re-activation without darkout and the second deploy

- [x] 4.1 `Deploy` ordering for `KindDeploy`: snapshot (unconditional) → `migrate.Apply` →
      `buildFrontend` → activate, as one operation
- [x] 4.2 `fail`/`rollback` closures: any failure after the snapshot restores the data
      snapshot, the on-disk `manifest.json` bytes, and re-registers the prior
      schema/store/asset-dir together; the job lands in `StateFailed` carrying the cause
- [x] 4.3 Dropping the manifest's `frontend` block on a version bump clears `AssetDir` to `""`
      as an intentional API-only transition, not a failure
- [x] 4.4 Tests: a second deploy that changes schema and rebuilds the frontend succeeds and
      both sides land together; a frontend-build failure after a successful migration rolls
      the migration back too; data is intact after a rollback; a retried deploy after a
      rollback succeeds; the previous artifact keeps serving every request made before cutover
      and across a failed rebuild

## 5. Boot reconciliation

- [x] 5.1 `Reconcile(reg, bst)` runs after `registry.Load`; first pass resolves every
      `InFlightJobs()` entry — completed to `ready` if `active_builds` already points at that
      exact job id and its artifact still exists on disk, else failed with a fixed message
- [x] 5.2 Second pass: every registered app's `ActiveBuildFor` pointer is checked for version
      match and on-disk artifact existence and reattached to the registry if valid, else
      reported broken and left unattached
- [x] 5.3 Wire `Reconcile` into `cmd/pocketknife/main.go`'s `serve` path, logging failed jobs,
      reattached apps, and broken pointers
- [x] 5.4 Tests: an interrupted job with no committed activation fails; a job whose activation
      committed just before a simulated crash completes to ready instead; a previously-ready
      app is reattached on reboot with no rebuild; a stale/missing pointer is reported broken
      and left unserved

## 6. Static asset serving and CORS

- [x] 6.1 Create `assets` package; `NewServer(reg)` serves `GET /ui/{app}/{path...}`,
      resolving `AssetDir`/entry file from the registry fresh on every request
- [x] 6.2 SPA fallback to the manifest's declared entry file (or `index.html`) for any
      unmatched path; 404 for an unknown app id or an app with no active build; path-traversal
      safe (cleaned and rooted under `AssetDir`)
- [x] 6.3 Create `cors` package; `Middleware(enabled, next)` — disabled is a transparent
      passthrough, enabled sets permissive headers and short-circuits `OPTIONS` with 204
- [x] 6.4 Wire both into `cmd/pocketknife/main.go`'s `serve` path behind a `-cors` flag
- [x] 6.5 Tests: known file served as-is, unknown path falls back to entry file, no-active-build
      app is 404, a cutover is visible to the next request with no restart, path traversal
      cannot escape `AssetDir`; CORS disabled is a no-op, CORS enabled answers preflight
      directly

## 7. Build-status HTTP surface

- [x] 7.1 `NewStatusServer(bst, reg)`: `GET /builds/{app}` (jobs most-recent-first + active
      pointer) and `GET /builds/job/{id}`, both using the same error envelope shape as the
      generic API
- [x] 7.2 404 for an unknown app id or unknown job id
- [x] 7.3 Wire into `cmd/pocketknife/main.go`'s `serve` path under `/builds/`
- [x] 7.4 Tests: list ordering, both 404 cases, active pointer present/absent

## 8. CLI and example apps

- [x] 8.1 Add a `build` subcommand to `cmd/pocketknife/main.go`: drives one `Deploy` call for
      an app, `-to` for a second deploy against a new manifest, `-confirm`/`-witnesses` passed
      through to `migrate.Options`
- [x] 8.2 Hand-author a real frontend (`src/app.ts` + `dist/index.html`) for each of the three
      Phase 1 example apps (`tasks`, `reading_tracker`, `gratitude_log`), each calling its own
      generated typed client and matching the entity operations its manifest actually allows
- [x] 8.3 Add a `frontend` block to each of the three apps' `manifest.json`; add a per-app
      `tsconfig.json` (ES2020 target, ESNext module, Bundler resolution) so the generated
      client and hand-authored app compile to browser-native ESM with no bundler

## 9. Gate / acceptance suite

- [x] 9.1 `tasks`, `reading_tracker`, `gratitude_log`: install, activate, open, exercise real
      CRUD/query end-to-end through the hand-authored frontend's generated client
- [x] 9.2 Deliberately break a build (gratitude_log) and confirm a legible, retriable `failed`
      state with no impact on any prior artifact
- [x] 9.3 Edit one app (reading_tracker) to trigger a second deploy needing both migration and
      frontend rebuild; confirm an injected failure rolls back cleanly with no darkout, then a
      retry succeeds
- [x] 9.4 Reboot mid-build (tasks): confirm reconciliation never darkens a previously-ready app
- [x] 9.5 Run `go build ./... && go vet ./... && go test ./...`; confirm all green
