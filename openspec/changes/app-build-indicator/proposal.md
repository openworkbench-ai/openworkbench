## Why

When the agent builds a **brand-new** app, the shell gives the user no signal that anything
is happening: the launcher grid already has full "Building…" UI (progress ring, pulsing
label, "Building N apps…" banner, 3s polling) driven by `GET /platform/registry`, but that
endpoint only lists apps that already have an `app_meta` row. For a first-time build,
`build.Bootstrap` doesn't create that row until the entire build — materialize, frontend
compile, DB open, activation — has already succeeded. So the new app simply doesn't exist in
the registry response until it's done; there is no `queued`/`building` state to observe. The
user taps "build it" and then sees nothing for however long the build takes, until the tile
appears already finished (or, on failure, never appears at all with no error surfaced).
Redeploys of existing apps don't have this problem since their `app_meta` row already exists.

## What Changes

- `build.Bootstrap` upserts the app's `app_meta` row (via the existing `EnsureAppMeta`,
  seeded from the manifest's `Name`/`Emoji`/`Color`) immediately after the build job
  transitions to `building`, instead of leaving that to the caller after the whole bootstrap
  succeeds. This is the one line that makes the app visible in `GET /platform/registry` with
  a real `buildState`.
- No shell changes: the launcher already polls the registry and renders `queued` / `building`
  / `activating` / `failed` states correctly (`AppTile.tsx`, `Home.tsx`, `useRegistry.ts`) —
  it just never received a row to render for first-time installs.
- On a failed first install, the `app_meta` row now persists (rather than never having
  existed), so the launcher shows the existing failed-build tile/toast instead of silence.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `platform-registry-api`: tighten the "App metadata stored in platform.db" requirement so
  the `app_meta` row (and therefore registry visibility) is guaranteed to exist from the
  moment a brand-new app's first build starts, not only after it finishes or fails.

## Impact

- `build/bootstrap.go`: add an `EnsureAppMeta` call right after the job transitions to
  `building`.
- `platform/registry.go` (`handleList`): fixed a latent bug found while implementing this
  change — a job in `StateFailed` fell through the existing state-detection loop without
  ever setting `buildState`, silently reporting `"none"` instead of `"failed"`. Replaced the
  loop with a direct "most recent job wins" lookup (`ListForApp` already returns jobs newest
  first) so terminal states, including `failed`, are always reported. Without this fix, a
  failed first install would still be invisible even after the `Bootstrap` change above.
- `deployapi/deployapi.go`: the existing post-bootstrap `EnsureAppMeta` call at line ~133
  becomes a harmless no-op for the first-install path (still needed for the redeploy path
  and as a defensive backstop) — no code change required there, `ON CONFLICT DO NOTHING`
  already makes it idempotent.
- No shell/frontend code changes.
- No database migration: `app_meta` table and `EnsureAppMeta` already exist.
