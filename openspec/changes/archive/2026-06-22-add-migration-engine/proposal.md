## Why

Pocketknife's Phase 1 derive pipeline turns a manifest into a working API and database, but
an app's schema cannot yet evolve: changing a manifest re-runs only idempotent `CREATE`
statements, so a rename, type change, or dropped field silently diverges the schema from the
data or destroys it. Evolving an owned app without losing data is the actual product — and
the hardest, most trust-critical engineering. This change builds that migration engine,
headless and model-free.

## What Changes

- **D1 storage refactor (prerequisite, BREAKING for on-disk layout):** physical SQLite
  table/column/index/FK identifiers derive from the immutable stable `id`, not the mutable
  display `name`. A rename becomes a pure manifest/registry change with **zero SQL**.
  Requires tightening manifest `stableId` validation to a SQL-safe pattern. Existing example
  `data.db` files (name-keyed) are regenerated.
- **Structural diff:** `diff(oldManifest, newManifest)` produces a typed, ordered
  `Changeset` keyed entirely by stable `id`, detecting added/dropped/renamed entities and
  fields, type changes, and constraint changes.
- **Classifier:** mechanically labels each operation **safe** (information-preserving →
  auto-apply) or **destructive** (information-losing → gated). The computed diff is ground
  truth; a caller annotation can never override the classification.
- **Snapshot / undo:** a byte-for-byte, WAL-safe file copy of `data.db` taken before any
  destructive migration, with byte-exact rollback and keep-last-N retention.
- **Executor:** applies a classified `Changeset` in one transaction per app database, using
  native `ADD COLUMN` / `DROP COLUMN` and the SQLite table-rebuild ("12-step ALTER")
  pattern for type/constraint changes, with `PRAGMA foreign_key_check` before commit.
- **Witness mechanism:** a declarative, closed vocabulary of coercions/backfills
  (type-narrowing coercion, `nullable → not-null` backfill, enum-value remap). A destructive
  op with no witness refuses to run — no default, no silent coercion.
- **Apply flow + CLI:** a single `apply-changeset` path (validate → diff → classify →
  witness/confirm → snapshot → execute → re-register; restore on failure), exposed via a new
  internal `migrate` package and a `pocketknife migrate` CLI subcommand. **No new HTTP
  surface.**
- **Pin the SQLite version floor (≥ 3.35) and assert it at boot.**
- The model-proposes-annotated-changeset verification seam is left **unimplemented** (no LLM
  in this phase).

## Capabilities

### New Capabilities
- `stable-id-storage`: physical database identifiers derive from stable `id` rather than
  display `name`, making renames zero-SQL and requiring SQL-safe `id` validation.
- `schema-diff`: structural diff of two manifest versions into a typed `Changeset`, plus the
  mechanical safe/destructive classifier that is the data-safety ground truth.
- `schema-migration`: snapshot/undo, the transactional executor, the declarative witness
  vocabulary, and the headless apply-changeset flow with its CLI entry point.

### Modified Capabilities
<!-- None: Phase 1 has no recorded specs yet; all capabilities here are new. -->

## Impact

- **New code:** `migrate/` package (changeset, diff, classify, snapshot, execute, witness,
  apply) and tests; `pocketknife migrate` subcommand in `cmd/pocketknife/main.go`.
- **Modified code:** `manifest.schema.json` (SQL-safe `stableId`), `validate/semantic.go`
  (id safety), `materialize/materialize.go` (name → id identifiers), `store/store.go`
  (id-keyed physical layer + version-floor assertion), `api/api.go`, `api/query.go`,
  `api/coerce.go` (name ↔ id translation boundary), `schema/schema.go` (`FieldByID`).
- **Data:** committed `apps/*/data.db` regenerated under id-keyed columns (throwaway example
  data; `make clean` removes them, boot re-creates them).
- **Dependencies:** none added; continues on `modernc.org/sqlite v1.53.0`.
- **No change** to the Phase 1 HTTP surface or to its observable CRUD/query behaviour.
