## Why

Phase 1's derive pipeline turns a manifest into a working API and database, and Phase 3 lets
that schema evolve without losing data, but neither phase makes an app *openable*: there is
still no way to turn a derived app's pre-built frontend into something serving traffic, no
record of whether a build succeeded or failed, and no safe way to swap to a new version
without darkening a running app. This change adds that build → activate half of the factory,
plus the typed client a hand-authored frontend needs to call the generic API correctly. The
LLM is still entirely out of scope; Phase 2's frontends are hand-authored and therefore
trusted, so the build pipeline has no sandbox yet.

## What Changes

- **Typed client generator:** a pure function of a validated `*schema.App` to a self-contained
  TypeScript module — per-entity row/Create/Update/List types, a per-entity client class
  exposing exactly the operations the manifest enables, and a root client composing them.
  Matches the generic API's URL scheme, query syntax, JSON shapes and error envelope
  byte-for-byte. Deterministic for an unchanged manifest.
- **Build-job state machine in a new platform database** (separate from every per-app
  `data.db`): `queued → building → activating → ready`, with `failed` reachable from every
  working state. A build job is a record of one *attempt*; retrying never reopens a failed
  job, it creates a new one, so the history of every attempt is preserved. Exposed read-only
  over HTTP for observability (`GET /builds/{app}`, `GET /builds/job/{id}`) — no streaming yet.
- **Static asset serving from the trusted core:** a new `assets` package serves an app's
  currently-active bundle at `GET /ui/{app}/{path...}`, resolving `AssetDir` fresh from the
  registry on every request (no caching, no restart needed for a cutover to take effect) with
  SPA fallback to the manifest's declared entry file. A new `cors` middleware is opt-in for
  local development, where the frontend is served separately from the API.
- **Activation and re-activation without darkout:** `Deploy` builds a new artifact into its
  own immutable, job-id-named directory under `apps/<id>/builds/`, never overwriting a
  previous one; only after the new artifact (and, for a second deploy, the new schema) is
  fully on disk does the durable cutover pointer (`active_builds`) and the in-memory registry
  get updated together. The previous artifact keeps serving every request up to that exact
  point.
- **The second deploy as one operation:** a new manifest version with both a schema change and
  a frontend rebuild is *not* two independently-committed steps. `Deploy` snapshots the data
  unconditionally, runs the Phase 3 migration, builds the new frontend, then activates; any
  failure after the snapshot rolls back the data, the manifest on disk, and the registry
  registration together, leaving the app exactly as openable as it was before `Deploy` was
  called.
- **Boot reconciliation:** extends the Phase 1 boot loader. On every start, every job left
  `queued`/`building`/`activating` is resolved — completed retroactively to `ready` if its
  activation had already durably committed, failed otherwise (a build cannot survive a
  process restart) — and every app's durable active-build pointer is re-validated and
  reattached to the freshly-booted, empty-`AssetDir` registry, so a reboot never darkens a
  previously-`ready` app.

## Capabilities

### New Capabilities
- `typed-client-generation`: deterministic TypeScript client generation from a validated
  schema, matching the generic API's contract exactly.
- `build-activation`: the build-job state machine, install and second-deploy orchestration,
  activation/re-activation without darkout, and boot reconciliation.
- `static-asset-serving`: per-app static frontend serving from the trusted core, plus opt-in
  CORS for local development.

### Modified Capabilities
<!-- None: this phase adds new capabilities on top of the unmodified Phase 1/3 surface. -->

## Impact

- **New code:** `client/` (TypeScript generator), `build/` (platform db, state machine,
  install/second-deploy orchestration, boot reconciliation, build-status HTTP server),
  `assets/` (static asset server), `cors/` (opt-in CORS middleware); `cmd/pocketknife/main.go`
  gains a `build` subcommand and wires the new servers into `serve`.
- **Modified code:** none of the frozen Phase 1 (`api/`) or Phase 3 (`migrate/`) contracts
  change; `build.Deploy` calls `migrate.Apply` as a black box.
- **Data:** a new platform-level SQLite database (`platform.db` by default) alongside every
  app's own `data.db`; per-app `apps/<id>/builds/<job_id>/` artifact directories.
- **Dependencies:** none added.
- **Out of scope, left as clean seams:** on-box bundling (no Node/esbuild in the trusted core
  — `Frontend.Dist` must already be a built static bundle), sandboxing/capability enforcement
  (frontends are trusted in this phase), the LLM and plan review, the shell UI and real-time
  build-progress streaming, auth.
