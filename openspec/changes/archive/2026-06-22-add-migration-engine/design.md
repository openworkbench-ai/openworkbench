## Context

Phase 1 (the derive pipeline) is built: `schema/` (typed model), `validate/` (JSON Schema +
semantic gate), `materialize/` (schema → DDL), `store/` (per-app SQLite, parameterized
CRUD/query), `api/` (generic HTTP surface), `registry/` (boot loader + in-memory registry).
One `data.db` per app, FK enforcement on per connection, single open connection serialising
writes, pure-Go `modernc.org/sqlite v1.53.0`.

Today the materializer and store name physical tables/columns after the mutable display
`name` (`materialize/materialize.go`, `store/store.go:selectColumns/encode/decode`). That
makes a rename indistinguishable from drop-plus-add and blocks safe evolution. This change
adds the migration engine and the D1 storage refactor it depends on. The build prompt and
`docs/pocketknife-design-context.md` are the source of truth for intent; three non-negotiable
invariants govern: snapshot before destructive change, computed diff is ground truth,
all-or-nothing per app.

## Goals / Non-Goals

**Goals:**
- Physical identifiers keyed by stable `id`; renames cost zero SQL.
- A standalone, deterministic structural diff and a mechanical safe/destructive classifier.
- Byte-exact, WAL-safe snapshot/undo.
- A transactional executor (native `ADD`/`DROP COLUMN`; table-rebuild for type/constraint
  changes) gated by declarative witnesses, explicit confirm, and a snapshot.
- A headless apply-changeset flow plus a `pocketknife migrate` CLI subcommand.

**Non-Goals:**
- No LLM proposing changesets; the verification seam is left unimplemented.
- No frontend, no shell, no new HTTP surface.
- No Turing-complete witnesses; declarative coercions only.
- No cross-app or multi-tenant migration; one app, one file, one transaction.

## Decisions

- **Physical names = stable id (D1).** Swap `name` for `id` in `materialize` and the `store`
  physical layer; the `api` layer becomes the single name↔id translation boundary (it already
  resolves names). *Alternative considered:* keep name-keyed columns and track renames via a
  side table — rejected: it reintroduces the drop/add ambiguity the stable id exists to kill.
- **Tighten `stableId` validation first.** Constrain ids to `^[a-z][a-z0-9_]*$` (same as
  `machineName`) before ids become DDL identifiers, closing an injection/broken-DDL hole.
  Existing app ids already comply, so no data churn — only `apps/*/data.db` regeneration
  (they are throwaway examples; `make clean` removes them).
- **Diff and classify are pure functions of the manifests.** No caller hint is consulted;
  a mis-annotated changeset is overridden by the computed class. This is the data-safety
  guarantee and gets tests on both sides of every boundary.
- **Executor uses one transaction per app + the documented SQLite table-rebuild** for
  type/constraint changes, with `PRAGMA foreign_keys` toggled around the rebuild and
  `PRAGMA foreign_key_check` before commit. Because Pocketknife owns the whole schema and
  there is one file per app, the rebuild is clean.
- **Snapshot is a file copy after `wal_checkpoint(TRUNCATE)`.** One file per app makes this a
  `cp`, not a dump. Retention keeps the last N (default 5) and/or until the next successful
  migration.
- **Witnesses are a closed Go vocabulary** (coercion / backfill / enum-remap), not an
  expression language. A destructive op without its required witness refuses to run.
- **Apply flow lives in a new `migrate` package; the CLI is a thin driver.** No new HTTP
  route; the confirm is an explicit flag, never implicit.

## Risks / Trade-offs

- **D1 refactor touches the whole read/write path** → land it behind the *unchanged* Phase 1
  test suite; the suite passing through the new translation boundary is the proof.
- **Opaque on-disk column names** (ids, not names) → accepted; nobody hand-reads `data.db`,
  the API resolves names.
- **Table-rebuild correctness (FK integrity, indexes)** → always run `foreign_key_check`
  before commit and rebuild indexes explicitly; cover cascade/restrict/set_null in tests.
- **Snapshot under WAL could capture an inconsistent point** → checkpoint-truncate before
  copy; a dedicated test mutates then restores and asserts byte-identity.
- **A false "safe" classification loses data** → when ambiguous, classify destructive; a
  false "destructive" only asks for a confirm.

## Migration Plan

Incremental, each step with its own tests and a green `make test` before the next: tighten
id validation → D1 refactor (materialize/store/api) + regenerate example DBs → changeset
model → diff → classify → snapshot → executor → witness → wire apply flow + CLI → engine
acceptance suite. Rollback at runtime is the snapshot restore; rollback of the change itself
is reverting the branch (example DBs regenerate on boot).

## Open Questions

- None blocking. LIKE case-sensitivity is fixed to SQLite's default (ASCII case-insensitive)
  and asserted; snapshot retention default N=5; both are documented and revisable.
