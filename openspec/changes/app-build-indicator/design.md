## Context

`build.Bootstrap` (`build/bootstrap.go`) runs the entire first-install lifecycle —
validate → stage → build frontend → materialize DDL → open store → rename into place →
`reg.Register` → activate — synchronously inside one function call, before returning to
`deployapi.firstInstall`. Only after that call returns does `deployapi.go:133` call
`bst.EnsureAppMeta(...)`, which creates the `app_meta` row `GET /platform/registry`
(`platform/registry.go:handleList`) requires to list an app at all. The shell's launcher
(`useRegistry.ts`, `Home.tsx`, `AppTile.tsx`) already polls that endpoint every 3s and
renders `queued`/`building`/`activating`/`failed` states correctly — it has simply never had
a row to poll for during a first build, since `app_meta` doesn't exist until the build is
already over.

Redeploys of already-registered apps (`build.Deploy`) don't have this gap: their `app_meta`
row was created on a prior install, so `handleList`'s job lookup already reports live
`buildState` for them mid-deploy.

## Goals / Non-Goals

**Goals:**
- Make a first-time app build observable in `GET /platform/registry` from the moment the
  build job starts, using only existing plumbing (`EnsureAppMeta`, the existing job-state
  lookup in `handleList`).
- Preserve current behavior for redeploys and for failure/rollback paths.

**Non-Goals:**
- No new HTTP endpoint, no new `platform.db` table/column, no polling-mechanism change in
  the shell — the existing 3s poll and `AppTile`/`Home` rendering already handle every state
  this change makes visible.
- No change to `deployapi`'s post-bootstrap `EnsureAppMeta` call; it stays as a defensive
  backstop and remains load-bearing for the redeploy path.
- Not addressing agent-side visibility (bridge SSE events) — the fix is entirely on the
  registry-polling path the shell already uses.

## Decisions

**Move `EnsureAppMeta` to fire right after the job transitions to `building`, inside
`Bootstrap`, rather than after the whole function returns.**

Placing it immediately after `bst.Transition(job.ID, StateBuilding, "")` succeeds (not
immediately after manifest validation) guarantees that whenever the `app_meta` row exists,
a matching non-terminal job also exists — so `handleList`'s job lookup always finds
`building` rather than momentarily reporting `buildState: "none"` for a row with no job yet.
Manifest `Name`/`Emoji`/`Color` are already available at that point (from `validate.Manifest`
at the top of `Bootstrap`), the same fields `deployapi.go:133` and `main.go:136` already pass
to `EnsureAppMeta` elsewhere.

Alternative considered: have `deployapi.firstInstall` call `EnsureAppMeta` *before* invoking
`Bootstrap`. Rejected because `firstInstall` would need to duplicate `validate.Manifest` to
get `app.Name`/`Emoji`/`Color` (or thread them through separately), and because leaving the
metadata upsert inside `Bootstrap` keeps "everything needed to observe a first install" in
one place rather than split across two packages.

**Reuse `EnsureAppMeta`'s existing `ON CONFLICT(app_id) DO NOTHING` semantics rather than
adding a new insert path.**

This makes the change a one-call addition with no new SQL, and makes retries after a failed
first install safe: if a first attempt fails (row created, job marked `failed`) and the
agent retries the same app id, the second `Bootstrap` call's `EnsureAppMeta` is a no-op
against the existing row, and the new job it creates is what `handleList` will report.

**Treat `EnsureAppMeta` failure inside `Bootstrap` as non-fatal (log and continue), matching
the existing pattern at `deployapi.go:134-136`.**

Losing display metadata is cosmetic (the launcher falls back to registry defaults); it must
never abort or roll back an otherwise-successful build.

## Risks / Trade-offs

- **[Risk]** A brand-new app now appears in the launcher grid (as a building tile) slightly
  before its directory is fully staged. → **Mitigation:** the grid only ever reads
  `app_meta` + job state, never the filesystem or the in-memory registry, so there is no
  path by which the shell could reach the unfinished app; `/ui/{appId}/` and the API remain
  unreachable until `reg.Register` runs later in `Bootstrap`, unchanged by this fix.
- **[Risk]** If `Bootstrap` fails before staging is cleaned up, the `app_meta` row (and thus
  a `failed` tile) now outlives the failed attempt, whereas before it never appeared.
  → **Mitigation:** this is the intended improvement (proposal.md) — a failed first build
  should be visible, not silent — and matches how failed redeploys already behave.

## Migration Plan

Single-commit code change in `build/bootstrap.go`; no data migration, no feature flag. Safe
to deploy directly: worst case on rollback is reverting to today's behavior (no early
visibility), not a data-loss or compatibility break.

## Open Questions

None — behavior, call sites, and idempotency were all confirmed by reading the current
implementation (`build/bootstrap.go`, `build/store.go:389-413`, `deployapi/deployapi.go:107-136`,
`platform/registry.go:29-77`) before writing this design.
