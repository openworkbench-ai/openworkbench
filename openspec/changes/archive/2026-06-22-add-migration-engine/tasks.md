## 1. Close the Phase 1 gate

- [x] 1.1 Add tests proving native FK behaviour for cascade, restrict, and set_null, with `PRAGMA foreign_keys` confirmed ON (extend `api/api_test.go` / add a store-level test)
- [x] 1.2 Decide and document LIKE case-sensitivity as SQLite default (ASCII case-insensitive); assert it in a test
- [x] 1.3 Confirm the seven operators plus AND, sort, and limit/offset are exercised end-to-end; fill any gap
- [x] 1.4 Gate check: sketch a fourth app; fix any forced manifest/API shape change before proceeding

## 2. D1 — stable-id physical storage

- [x] 2.1 Tighten `stableId` in `manifest.schema.json` to `^[a-z][a-z0-9_]*$`; add a semantic id-safety check and validator tests
- [x] 2.2 `materialize/materialize.go`: emit `ent.ID` / `f.ID` / `target.ID` for tables, columns, FK targets, and unique-index names
- [x] 2.3 Translation boundary kept in `store` via a single `physCol` helper (logical name → physical id); the store's public interface stays name-keyed so `api/*` is unchanged — `Entity.FieldByID` deferred to the migrate package where id-keyed lookups are actually needed
- [x] 2.4 `store/store.go`: Insert/Update/Delete/List/GetByID/Exists emit `ent.ID` tables and `physCol`-resolved columns; `encode`/`decode` stay name-keyed
- [x] 2.5 `api/` unchanged: it already passes display names; the store resolves them to ids at the single boundary (verified end-to-end via smoke test + full suite)
- [x] 2.6 Regenerate example `apps/*/data.db` and re-run the full Phase 1 suite to prove behaviour is preserved

## 3. Changeset model and structural diff

- [x] 3.1 Create the `migrate` package and define the `Changeset` type covering every taxonomy op (add/drop/rename entity & field, type-changed, constraint-changed, uniqueness), keyed by stable id, with an optional witness and an unused annotation seam
- [x] 3.2 Implement `diff(old, new) → Changeset` keyed by stable id; detect added/dropped/renamed/type-changed/constraint-changed
- [x] 3.3 Tests: diff against hand-authored old/new manifest pairs of the three apps; assert rename is same-id, add/drop are id-based, type/constraint changes detected

## 4. Classifier

- [x] 4.1 Implement the safe/destructive classifier per the §6 taxonomy; when ambiguous, destructive
- [x] 4.2 Tests on both sides of every boundary (integer→real vs real→integer; not-null→nullable vs nullable→not-null; add-enum-value vs remove-enum-value; etc.)
- [x] 4.3 Test that a caller annotation cannot override the computed classification

## 5. Snapshot / undo

- [x] 5.1 Implement snapshot: `PRAGMA wal_checkpoint(TRUNCATE)` then byte-for-byte copy of `data.db` (store now runs in WAL mode; added `Store.Checkpoint`)
- [x] 5.2 Implement byte-exact rollback (clears -wal/-shm sidecars) and keep-last-N retention (default N=5) via `Prune`
- [x] 5.3 WAL test: snapshot, mutate, restore, assert byte-identical recovery + snapshot-moment data

## 6. Executor

- [x] 6.1 Pin SQLite floor (≥ 3.35) and assert the linked version at boot, failing fast otherwise
- [x] 6.2 Implement native safe ops: `CREATE TABLE`, `ADD COLUMN`, `DROP COLUMN`; rename preserves data (strict zero-SQL assertion in 9.x)
- [x] 6.3 Implement the table-rebuild pattern for type/constraint changes with `PRAGMA foreign_keys` toggle and `PRAGMA foreign_key_check` before commit (store.RunMigration)
- [x] 6.4 Run the whole changeset inside one transaction per app; on failure roll back (snapshot restore wired in the apply flow)

## 7. Witness mechanism

- [x] 7.1 Implement the closed witness vocabulary: type-narrowing coercion (truncate/round/fail), nullable→not-null backfill, enum-value remap
- [x] 7.2 Enforce that a destructive op with no required witness refuses to run (pre-flight `MissingWitnesses` + executor refusal; no default, no silent coercion)

## 8. Apply flow and CLI

- [x] 8.1 Implement the single apply-changeset path: validate → diff → classify → witness/confirm → snapshot → execute → re-register; restore + keep prior registration on failure
- [x] 8.2 Require an explicit confirm flag whenever any destructive op is present
- [x] 8.3 Add a `pocketknife migrate` CLI subcommand driving the flow; add no new HTTP route

## 9. Engine acceptance suite

- [x] 9.1 Safe: rename a field (assert zero SQL), add nullable field, add entity + reference, widen integer→real — each auto-applies with no data loss
- [x] 9.2 Destructive: drop a field (blocked without confirm; snapshot; undo byte-exact), narrow type with witness, nullable→not-null refuses without backfill witness
- [x] 9.3 Negative: a mis-annotated changeset is overridden by the computed classification
- [x] 9.4 Run `make test`, `make vet`, `make fmt` (and `-race`); confirm all green
