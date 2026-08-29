## Context

Phase 1 (schema/validate/materialize/store/api/registry) and Phase 3 (migrate:
diff/classify/snapshot/execute/witness/apply) are built and gated. Registry.Load always
starts every app with `AssetDir` empty — Phase 1 has no notion of a build. This change is
the first thing that ever sets `AssetDir`.

## Goals / Non-Goals

**Goals:**
- A typed TS client generated purely from the schema model, with byte-identical output for
  an unchanged manifest.
- A small, explicit build-job state machine, in its own platform database, with a real and
  observable failure path.
- Activation that never darkens a running app, even across a failed rebuild or a mid-build
  process death.
- A second deploy (migration + rebuild) landed as one operation with one rollback contract.

**Non-Goals:**
- No on-box bundling: the trusted core never invokes Node/esbuild; `Frontend.Dist` must
  already point at a built bundle.
- No sandboxing of frontend code — frontends are hand-authored and trusted in this phase.
- No LLM, no plan review, no shell UI, no real-time build-progress streaming (status is
  polled, not pushed).
- No auth.

## Decisions

- **Platform db is separate from every app's data.db.** A build job describes the *act* of
  building, never the app's own data; keeping it in its own SQLite file means a botched
  migration snapshot/restore on an app's data.db can never also corrupt build history.
- **State machine has five states; `failed` is reachable from every working state and is
  itself terminal alongside `ready`. A retry always creates a new job row.** Reopening a
  failed job would let a job's history lie about what actually happened during a given
  attempt; CreateJob + Transition enforce this via an explicit `allowedTransitions` map, not
  convention.
- **Kind (`install` vs `deploy`) is derived, not passed in.** `Deploy` compares the incoming
  manifest's version against the currently-registered schema version; the caller never has
  to (and cannot) misdeclare which kind of build is happening.
- **Build artifacts are versioned by job id, never overwritten in place.**
  `apps/<id>/builds/<job-id>/` is fresh for every attempt; a half-finished copy can never be
  promoted because activation only happens after `copyDir` returns successfully, and pruning
  removes old artifacts by directory modification time (job ids are random and carry no
  chronological order) after a successful cutover, keeping a short retained tail (default 5).
- **Second-deploy ordering is unconditional snapshot → migrate → build frontend → activate.**
  The snapshot happens even for a deploy that turns out to need no destructive operation,
  because the *next* step (the frontend build) can still fail after the migration has
  already committed — the deploy is one operation with one rollback path, not two
  independently-committed ones. Rollback closes and reopens the store, restores the
  snapshot, restores `manifest.json` bytes on disk, and re-registers the prior
  `Schema`/`Store`/`AssetDir` together.
- **Activation cutover updates the durable pointer (`active_builds`, one row per app,
  upserted) and the in-memory registry together, only after the new artifact is fully on
  disk.** `active_builds` is the source of truth boot reconciliation reads; the in-memory
  registry is rebuilt fresh on every boot and has to be told to reattach.
- **Dropping the `frontend` block on a version bump is an intentional API-only transition,
  not a failure.** `AssetDir` is cleared to `""`; the app keeps serving its API, just not a
  UI.
- **Reconciliation runs two independent passes after `registry.Load`.** First, every
  in-flight job is resolved — if its own activation already durably committed (the
  `active_builds` row points at that exact job id and the artifact still exists on disk), it
  is completed retroactively to `ready`; otherwise it is failed with a fixed, diagnosable
  message, since no build can survive a process restart. Second, every registered app's
  durable active-build pointer is independently checked for version match and artifact
  existence and reattached if valid (else reported broken and left unattached) — this is the
  half that actually prevents reboot darkout, and it runs regardless of whether that app had
  any in-flight job at all.
- **Static asset serving resolves `AssetDir` fresh on every request, never at server-start.**
  A cutover (or a rollback) is visible to the very next HTTP request with no restart of the
  asset server.
- **CORS is opt-in and global, not per-app.** Production runs the API and the UI from one
  origin (no CORS needed); local development with a separately-served frontend turns CORS on
  for the whole binary via a flag.

## Risks / Trade-offs

- **A crash between the durable `PromoteActive` commit and the in-process
  `Transition(StateReady)` call** would otherwise mislabel a successfully-activated build as
  failed → reconciliation special-cases exactly this window by checking `active_builds`
  before failing an in-flight job.
- **An intentional frontend removal leaves a stale `active_builds` row** (pointing at an
  asset dir no longer referenced by the live schema) rather than deleting it → harmless:
  reconciliation's version-mismatch guard already refuses to reattach a pointer whose
  `manifest_version` doesn't match the currently-registered schema, so the stale row is never
  served. Left as-is rather than adding an explicit pointer-deletion API the brief did not
  ask for.
- **Build artifact retention (default 5) could in principle race with an in-flight
  rollback** reading an older artifact → pruning only ever runs after a successful
  activation's own cutover has already committed, never before or during a rollback.

## Migration Plan

Additive: a fresh `platform.db` is created on first use; no existing Phase 1/3 data or
schema changes. Boot reconciliation is the only new behavior that runs unconditionally on
every start, and it is a no-op when there is no build history yet (a freshly-derived app
with no `Deploy` ever run has no `active_builds` row and no in-flight job).

## Open Questions

None blocking. Build-progress streaming and on-box bundling are explicitly deferred (Phase
5-6); the seams (`Job`/`State`, `Frontend.Dist`) are left clean for them.
