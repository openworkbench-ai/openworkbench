## Context

Pocketknife already has the backend pieces to *update* an app's schema: `build.Deploy` (`Kind=deploy`) runs a data-preserving migration + frontend rebuild + activation with one rollback contract, and `/deploy` routes a known `app.id` to it; the migration engine matches **entirely by stable id**.

It also already has the right spine for versioned frontend artifacts:
- **Job-versioned immutable build dirs** — every deploy copies its bundle into `apps/<id>/builds/<jobID>/`, never overwritten, pruned to a short tail by mod-time (`build/frontend.go`).
- **A durable activation pointer** — the `active_builds` table in `platform.db` records which jobID is live per app; rollback is a repoint (`build/store.go`).
- **Contained ingest** — `/deploy` extracts the `bundle` tar under path-traversal/symlink/size guards (`build.ExtractBundle`).

Two things are missing for "update apps". First, the **editable frontend source never persists**: the submitter ships only `dist/` (`seams/submitter.ts` — "Ship the built bundle, not the source… the source under src/ … never leave the scratch directory"), and the scratch dir is keyed per ephemeral run. Second, the **agent always authors fresh** — new app id, new stable ids, blank scaffold — so it cannot target and edit an existing app.

## Goals / Non-Goals

**Goals:**
- The editable frontend source of every deploy is durably persisted on the backend, versioned and pinned exactly like the bundle it was built from.
- An agent user can name an existing app id, fetch its **live** manifest + source, change schema and/or UI conversationally, and redeploy as a data-preserving update.
- App id and entity/field stable ids survive edits, so the stable-id-matched migration does the right thing.
- The default new-app flow (and the local/stub flow) is unchanged; legacy apps without stored source still update via manifest-driven regeneration.

**Non-Goals:**
- No server-side building of source — the backend never runs `npm`/vite; the agent stays the only builder.
- No new database or mutable repository subsystem — source rides the existing build-artifact + activation spine.
- No change to the migration engine, the validation gate, or the `/deploy` routing logic.
- No authentication on the export endpoint (inherits `/deploy`'s known, separately-tracked gap); no app discovery/list endpoint.

## Decisions

**1. Source is just another artifact of the build job, pinned by the same activation pointer.**
Store the editable scaffold under `apps/<id>/sources/<jobID>/`, a sibling of `apps/<id>/builds/<jobID>/`, keyed by the same jobID and governed by the same `active_builds` pointer and the same tail-prune. *Why:* the "what's live" question is already answered by one pointer; tying source to the same jobID means a rollback repoints source and bundle together — source can never drift from the live build. *Alternatives:* a blob column in `platform.db` (inconsistent — bundles live on disk, and it bloats the platform db); a separate git-like mutable repo (a second source of truth with its own lifecycle — reintroduces the drift-vs-activation risk this design exists to avoid).

**2. A parallel `sources/<jobID>/` tree, not a restructure of `builds/<jobID>/`.**
Leave `builds/<jobID>/` as the dist root the assets server already serves verbatim; put source in a parallel `sources/` dir. *Why:* the assets-serving path is untouched and source is never reachable over `/ui`. *Alternative:* reshape `builds/<jobID>/` into `dist/` + `source/` — churns the assets server and reconcile/prune logic for no benefit.

**3. Source is stored opaquely and never executed on the backend.**
The backend writes the extracted source tar to `sources/<jobID>/` and reads it back on export; it never installs deps or builds it. *Why:* preserves the standing "no on-box bundling" invariant and the sandbox posture — the agent host is the only place untrusted code runs. The source archive is contained by the **same** `ExtractBundle` guards as the bundle.

**4. The `source` ingest part is optional; export degrades gracefully.**
`/deploy` accepts `source` as an optional multipart part. Export reports whether the active build has source on file; when it doesn't (legacy app, or a deploy that shipped none), the agent **falls back to regenerating the frontend from the manifest**. *Why:* makes this a strict superset of "regenerate from manifest", keeps the stub/local default flow and pre-existing apps working, and lets the feature roll out without a backfill.

**5. Preserve ids by seeding the planner with the real manifest and constraining it — not post-hoc id reconciliation.**
The planner starts from the fetched manifest verbatim; the manifest skill/instructions require keeping `app.id` and all stable ids (only rename/add/remove). A submit-time guard asserts the outgoing `app.id` equals the fetched id before the irreversible step. *Why:* the stable-id contract already does exactly the right migration when ids are preserved; reconciling freely-authored ids on the backend is brittle and defeats that contract.

**6. App-source fetch is a selectable seam mirroring the submitter.**
An `AppSourceFetcher` interface selected in `seams/select.ts` by the same env switch as the submitter; HTTP impl reads the export endpoint, default/stub stays offline. The submitter is extended to also tar `src/` (minus `node_modules`/`dist`) as the `source` part. *Why:* reuses the proven seam pattern and keeps update mode opt-in and testable offline.

## Risks / Trade-offs

- **Source diverges from the served bundle** → mitigated structurally: both share the jobID and the single activation pointer, so they cut over and roll back together (Decision 1).
- **Planner mints a new id or drops a stable id** → redeploy would look destructive or like a new app. Mitigation: validation + a submit-time guard that `app.id` is unchanged and previously-present stable ids didn't silently vanish.
- **Source archive bloat / disk exhaustion** → mitigated by excluding `node_modules`/`dist`, the same size/entry caps as the bundle, and the existing tail-prune retiring old `sources/<jobID>/` with their builds.
- **Stored source is untrusted and could carry a traversal/symlink payload** → contained by reusing `build.ExtractBundle`; and the backend never executes it.
- **Unauthenticated export leaks manifest + source** → explicitly inherits `/deploy`'s known gap; documented and separately tracked, not solved here.
- **Concurrent update + deploy of the same app** → existing per-app-id serialization on the deploy path covers the write; export is read-only and side-effect free.

## Migration Plan

Additive and backward-compatible. The `source` part is optional, so old agents/clients and the stub flow keep working; apps deployed before this change simply have no `sources/<jobID>/` and update via manifest-driven regeneration until their next source-bearing deploy. No platform-db schema change is strictly required (the activation pointer already names the jobID that locates the source); if a per-build `has_source` flag is added it is nullable/defaulted. Rollback of this feature is removal of the new endpoint, the `source` ingest handling, and the `--app` path — nothing else depends on them.

## Open Questions

- Exact export endpoint shape/name (`GET /apps/{id}/source` vs a sibling `/export` server) and response encoding (single multipart of manifest+source vs JSON manifest + separate source stream) — pin to match `deployapi` conventions during implementation.
- Whether to record a `has_source` column in `active_builds`/job rows or infer source presence purely from the existence of `sources/<jobID>/`.
- Whether the submit-time guard should hard-fail or only warn when a previously-present stable id disappears without an explicit user-requested removal.
