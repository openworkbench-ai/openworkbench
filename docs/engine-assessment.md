# Pocketknife → Workbench: Technical Assessment

*Scope: the Go backend (this repository root, excluding `agent/`, `shell/`, `openspec/`). Produced by direct reading of `README.md`, `cmd/pocketknife/main.go`, `manifest.schema.json`, `docs/pocketknife-design-context.md`, and every package under review, cross-checked by four independent research passes. All claims are cited `file:line`; anything not directly verified is flagged as such. No code was changed.*

*Working-tree note: at the time of this review, `git status` shows the entire `apps/` example-app tree (manifests + built frontends for `baby_tracker` and others) as locally deleted but not committed. This is pre-existing uncommitted state in the working tree, not something this review touched. Its practical effect: `api/*_test.go` and `build/acceptance_test.go` currently fail locally with `open ../apps: no such file or directory`, because they depend on real fixtures under `apps/`. All statements below about those tests describe what the code asserts and is designed to verify, not a fresh run in this exact checkout.*

---

## 1. Executive Summary

Pocketknife is a **single Go binary that turns a declarative JSON manifest into a live CRUD API plus an isolated SQLite database, with no code generation and no per-app process.** The core loop: manifest JSON → parsed into a plain Go struct tree (`schema/`) → validated as a hard gate (`validate/`) → lowered into idempotent SQLite DDL (`materialize/`) → opened as a per-app connection (`store/`) → served by one generic set of HTTP CRUD/list handlers that look the app up in an in-memory registry at request time (`api/`, `registry/`). There is no per-app compiled code anywhere.

Four largely independent subsystems sit on top of that core, at very different levels of production-readiness:

1. **A schema-migration engine (`migrate/`)** — evolves an app from one manifest version to the next without losing data, via a stable-id structural diff, a safe/destructive classifier that never trusts a caller hint, an explicit "witness" mechanism for anything information-losing, a file-copy snapshot, and single-transaction execution. This is the most mature, most carefully designed, and most heavily tested part of the codebase — and per the project's own design document (`docs/pocketknife-design-context.md`, §3), it is explicitly "the actual product": *"Creating an app is the demo; evolving one without losing data is the product, and it's the hardest engineering."*
2. **A build/activation/deploy pipeline (`build/`, `deployapi/`)** — lands a pre-built frontend bundle and/or a migrated schema as one atomic operation with a documented rollback contract, backed by a separate `platform.db`, exposed to external tools (today, the Node `agent/`) through an intentionally unauthenticated `POST /deploy` ingest endpoint.
3. **A capability-sandboxed WebAssembly function runtime (`sandbox/`, `broker/`, `consent/`)** — genuinely strong isolation (wazero, enforced memory/timeout/byte caps, a capability-checked host ABI, a model-provider token the guest can never observe), rigorously tested for exactly those properties — but **it has zero callers anywhere in the running server.** This is the single most important "looks done, isn't wired up" finding in the whole review.
4. **A shell (React SPA) + platform API (`platform/`) + Claude-agent bridge** — single-admin session auth, an SSE-streamed conversational app-authoring flow that shells out to a Node/TypeScript agent subprocess. Notably, that agent process already runs its own in-process MCP server exposing two tools (`validate_manifest`, `ready_to_build`) to its own planning loop — a working precedent, inside this codebase, for MCP-style tool exposure, just not yet applied to the CRUD/data surface.

**Maturity is uneven, and the unevenness is legible rather than hidden.** The request/boot core and the migration engine are stable, disciplined, and match their own documentation almost exactly. The build/deploy layer has one real, if narrow, asymmetry (no rollback for a couple of late-stage activation failures — see §8/§15). The sandbox is architecturally excellent but inert. The shell/agent bridge and the platform's auth model are single-user by design, not multi-tenant.

**What the original architecture was built for**, confirmed rather than inferred (`docs/pocketknife-design-context.md`): a **self-hosted, single-user personal app platform** where an LLM proposes manifests and frontends conversationally, a deterministic verifier gates everything the model produces before it touches the trusted core ("the model is an untrusted synthesis oracle... nothing the model emits reaches the system unchecked"), and the migration engine is what lets those AI-authored apps survive change without being disposable. It was never designed for multi-tenancy, RBAC, or hosted SaaS — that reframing is genuinely new work for Workbench, not something half-built here already.

---

## 2. Architecture

### Packages

| Package | Role | LOC (incl. tests) | Test files |
|---|---|---|---|
| `schema/` | Manifest → typed IR (`App`/`Entity`/`Field`/`Function`/`Capabilities`) | 450 | **0** |
| `validate/` | JSON-Schema + semantic hard gate | 625 | 1 (17 tests) |
| `materialize/` | IR → SQLite DDL | 334 | 1 |
| `store/` | Per-app SQLite connection, parameterized CRUD/list | 556 | 1 (thin — 1 direct test) |
| `api/` | Generic HTTP CRUD/list handlers, query parser, error envelope | 1,113 | 2 |
| `registry/` | In-memory app registry, boot loader | 368 | 1 |
| `migrate/` | Diff → Classify → Witness → Snapshot → Execute | 2,894 | 9 files, 41 tests |
| `build/` | Build/activation orchestration, platform.db | 3,358 | 11 |
| `deployapi/` | `POST /deploy` ingest, `GET /export/` | 1,201 | 3 |
| `platform/` | Session auth, registry API, agent bridge (SSE) | 1,195 | 1 (13 tests) |
| `sandbox/` | wazero WASM isolation + capability-checked host ABI | 2,111 | 1 file, 955 lines, 24 tests |
| `broker/` | Sole path from a sandboxed function to a model provider | 236 | 1 (6 tests) |
| `consent/` | Pure capability-union derivation | 399 | 2 (10 tests) |
| `client/` | Deterministic TypeScript client codegen | 436 | 1 |
| `assets/`, `cors/`, `validateapi/`, `shellserve/` | Static/dev-only/dry-run/SPA serving | ~513 | 4 |
| `cmd/pocketknife/` | serve / migrate / build entrypoint | 300 | — |

External dependencies (`go.mod`): `santhosh-tekuri/jsonschema/v6` (structural validation), `modernc.org/sqlite` (pure-Go SQLite, no cgo), `tetratelabs/wazero` (pure-Go WASM runtime). Everything else is stdlib (`net/http`, `golang.org/x/crypto/bcrypt`). No web framework, no ORM.

### Actual boot / request flow

```
apps/<id>/manifest.json
        │  registry.Load (registry/boot.go:34)
        ▼
schema.Parse (schema/parse.go:76) ──► *schema.App   (pure Go struct, no HTTP/SQL)
        │
        ▼
validate.Manifest (validate/validate.go:79)   — hard gate: JSON-Schema structural pass
        │                                        + Go semantic checks (validate/semantic.go)
        │  fail → skip this app, log, continue booting the rest
        ▼
materialize.Statements (materialize/materialize.go:30) ──► idempotent SQLite DDL strings
        ▼
store.Open (store/store.go:48) ──► apps/<id>/data.db  (one *sql.DB, MaxOpenConns(1))
        ▼
registry.Register (registry/registry.go:41)  ──► in-memory map[string]*RegisteredApp
        │
        ├──► api.NewServer(reg)        generic CRUD/list HTTP handlers, per app+entity
        ├──► assets.NewServer(reg)     serves each app's activated frontend at /ui/{app}/
        └──► client.Generate(app)      pure fn *schema.App → TypeScript client

Parallel subsystems orbiting the same registry + schema model:

migrate.Apply(reg, appID, newManifest, opts)
    Diff → Classify → confirm+witness gate → Snapshot → Execute (1 tx) → re-register

build.Deploy / build.Bootstrap
    snapshot data → migrate.Apply → build frontend → activate — one rollback contract,
    durable state in platform.db (separate from any app's data.db)

deployapi.NewServer(reg, bst, appsDir)   POST /deploy: multipart(jobId, manifest, bundle)
    → build.Bootstrap (unknown app id) | build.Deploy (known app id)
    idempotent on jobId, per-app-id mutex serialization (deployapi.go:40-66)

platform.NewServer(bst, reg, agentBin, addr)
    session auth (the ONLY auth-gated subtree) + registry CRUD + agent-bridge (SSE)

sandbox.Invoke + broker.Broker + consent.Union
    wazero-isolated WASM functions, capability-gated host ABI
    — fully built and tested, ZERO callers outside their own tests
```

Entry-point wiring, verbatim, is `cmd/pocketknife/main.go:151-160`: one `http.ServeMux` — `/apps/`→`api`, `/builds/`→`build`, `/ui/`→`assets`, `/validate`→`validateapi`, `/deploy`→`deployapi`, `/export/`→`deployapi`, `/platform/`→`platform` (**the only auth-gated subtree**), `/`→`shellserve` (catch-all, must be registered last).

---

## 3. Application Manifest

One JSON document per app version, at `apps/<app_id>/manifest.json`. Structural contract: `manifest.schema.json` (embedded into the binary via `schema_embed.go`), enforced by `validate.Manifest`'s layer 1. Semantic rules layered on top in `validate/semantic.go`.

**Required:** `app.id`, `app.name`, `app.version` (int ≥ 1), `entities` (≥ 1, each with `id`/`name`/`fields`), `field.id`/`name`/`type`.

**Optional:** `app.emoji`, `app.color` (shell tile display); per-entity `operations` (subset of `create/read/update/delete`, default all four — a disabled op returns HTTP 405); `frontend` (`{dist, entry}`, a pre-built static bundle — pocketknife never compiles a frontend on-box); `functions` (sandboxed WASM entries with a `capabilities` block).

**Closed type set (7 types)**, defined as Go constants at `schema/schema.go:14-22`: `text, integer, real, boolean, datetime, enum, reference`. Each type has its own allowed-constraint-key subset, enforced structurally by per-type `oneOf` defs in `manifest.schema.json` and semantically in `validate/semantic.go`.

**Stable IDs are the spine**: `app.id`/`entity.id`/`field.id`/`function.id` are immutable; `name` is a mutable display value and SQL identifier. This split is what lets the migration engine treat a rename as "same column, different label" (§6). `name`/`id` must match `^[a-z][a-z0-9_]*$` (`manifest.schema.json` `$defs/stableId`/`machineName`), with a Go-side backstop in `validate/semantic.go:44-46,53-55` specifically for id-vs-reserved-name collisions the regex alone can't catch (`id`, `created_at`, `updated_at` are reserved).

**Representative manifest** (from `README.md`, cross-checked against `schema/schema.go`):

```json
{
  "app": { "id": "reading_tracker", "name": "Reading Tracker", "emoji": "📚", "color": "#8E86CF", "version": 1 },
  "entities": [
    { "id": "ent_book", "name": "book", "operations": ["create", "read", "update", "delete"],
      "fields": [
        { "id": "fld_title",  "name": "title",  "type": "text",    "required": true, "max": 200 },
        { "id": "fld_rating", "name": "rating", "type": "integer", "min": 1, "max": 5 }
      ] }
  ],
  "frontend": { "dist": "frontend/dist", "entry": "index.html" },
  "functions": [
    { "id": "fn_x", "name": "x", "entry": "functions/x.wasm",
      "capabilities": {
        "data": [{ "entity": "ent_book", "operations": ["read"] }],
        "network": ["api.example.com"],
        "model": true
      } }
  ]
}
```

**Manifest → running app, exact path**: `registry/boot.go:34-88` — read `manifest.json` → `validate.Manifest(data)` (fail → `continue`, this app is never materialized or registered) → `materialize.Statements(app)` → `store.Open(dir/data.db)` → `st.ApplyDDL(stmts)` → `reg.Register(...)`. **This is the only call chain in the entire repo that reaches `materialize.Statements`/`registry.Register`** — confirmed by grep across `migrate/`, `build/`, `deployapi/`, all of which route back through `validate.Manifest` before ever touching materialization or the registry. Validation is a genuine hard gate, not just documented as one.

At boot, one bad manifest is logged and skipped; the rest of the boot proceeds (`cmd/pocketknife/main.go:96-108`; confirmed by `registry/boot_test.go`'s `TestInvalidManifestIsSkippedNotServed`) — a broken app cannot take the server down.

**Error shape**: `validate.Error{Path, Code, Message string}` (`validate/validate.go:29-33`), collected into an actual list (`Errors`), not first-error-wins. 17 distinct semantic rules are each individually negative-tested (`validate/validate_test.go`): unknown top-level/field keys, disallowed constraint keys for a type, unknown type, reserved/duplicate/unsafe stable IDs, unresolved references, enum defaults not in `values`, defaults violating a field's own constraints, reserved-column collisions, plus a positive `TestExampleAppsAreValid` and a structural-shape assertion `TestErrorsAreStructuredWithPath`.

---

## 4. Internal Application Model

```go
// schema/schema.go
type App struct {
    ID, Name, Emoji, Color string
    Version                int
    Entities                []*Entity
    Frontend                *Frontend
    Functions               []*Function
}
type Entity struct { ID, Name string; Operations []Operation; Fields []*Field }
type Field struct {
    ID, Name string
    Type                          FieldType
    Required, Unique, HasDefault  bool
    Default                       any
    Min, Max                      *float64
    Values                        []string   // enum
    Target, OnDelete              string     // reference
}
type Capabilities struct { Data []DataScope; Network []string; Model bool }
```

- **Created by**: `schema.Parse(data []byte) (*App, error)` (`schema/parse.go:76`) — unmarshals into permissive intermediate `raw*` structs, then normalizes (defaults such as all-four-operations, `OnDelete: set_null`, `entry: index.html`; typed `Default`-value coercion via `normaliseDefault`).
- **Consumed by**: every other package — `validate/`, `materialize/`, `store/`, `api/`, `migrate/`, `client/`, `sandbox/` all speak this vocabulary. It is the one shared domain model in the system.
- **Coupling: genuinely clean.** `schema/schema.go` has zero imports; `schema/parse.go` imports only `encoding/json` and `fmt`. No `database/sql`, no `net/http`, anywhere in the package — confirmed by grep and stated as explicit intent in the package doc comment. This is the single strongest architectural asset in the repo for a Workbench pivot: the domain model is already transport- and storage-agnostic. Storage coupling is introduced one level up, in `registry.RegisteredApp{Schema *schema.App, Store *store.Store, ...}` (`registry/registry.go:18-26`) — not inside the model itself.
- **Public vs. internal**: `*schema.App` is never serialized back over the wire as-is; `client.Generate` and `materialize.Statements` each render *from* it into a different target (TypeScript, SQL).
- **One soft spot**: `FieldType(rf.Type)` in `Parse` (`parse.go:107`) is a bare string cast — nothing in `schema/` itself rejects an unrecognized type string; the JSON-Schema `enum` constraint is what actually closes the type set, one layer up in `validate/`. This is safe today because `Parse` is only ever called from inside `validate.Manifest` after the structural pass runs first — but it means `schema.Parse` alone is **not** a safe public entry point. A future caller (an MCP tool, a direct API) that calls `schema.Parse` without first running `validate.Manifest` would silently bypass the entire type-closure guarantee.

---

## 5. Storage Layer

**Creation**: `store.Open(path string)` (`store/store.go:48`) opens one `*sql.DB` per app at `apps/<id>/data.db` (path assembled by the caller, e.g. `registry/boot.go:70`). DSN pragmas: `foreign_keys(1)`, `busy_timeout(5000)`, `journal_mode(WAL)`. `db.SetMaxOpenConns(1)` — a single, serialized connection per app, a deliberate choice to avoid SQLite writer-lock contention rather than pool connections.

**DDL generation** (`materialize/materialize.go`): built via `fmt.Sprintf`/`strings.Builder` string concatenation — no query builder, no ORM. The one thing that makes this safe: **every identifier interpolated into DDL is a schema-model stable id, never request data** (`materialize.go:107,139-143`), and that id has already been proven SQL-safe against `^[a-z][a-z0-9_]*$` by `validate.Manifest` before `materialize` ever runs. The only *literal values* embedded (not identifiers) are enum `CHECK` constants, single-quote-escaped (`enumLiterals`, `materialize.go:203-212`) — schema constants, never row data. `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` make materialization idempotent (verified by `TestPlatformColumnsAlwaysPresent`, `TestTypeMappingAndChecks`, and indirectly by `registry`'s boot-idempotency test). Automatic columns are unconditionally prepended: `id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL` (`materialize.go:24`).

**CRUD** (`store/store.go:197-338`, `Insert/GetByID/List/Update/Delete/Exists`): all row *values* are bound `?` parameters, never interpolated — confirmed at every call site. Column names go through `physCol` (`store.go:353-373`), which resolves a logical field name to its physical (stable-id-keyed) column only via `ent.Field(logical)` lookup against the already-validated schema; the one raw-passthrough fallback branch is explicitly commented "unreachable for validated input: callers only pass known columns" (`store.go:361`) and is only reachable from `api/` and `sandbox/`, both of which only ever pass field names drawn from the schema itself — there is no independent re-validation at this layer, it trusts the upstream gate by design.

**Transactions**: `RunMigration(ctx, fn func(*sql.Tx) error)` (`store.go:146-177`) pins a connection, disables FK checks for the transaction's duration (SQLite can't toggle this mid-transaction), runs the caller's function, runs `PRAGMA foreign_key_check` before commit, and rolls back on any error.

**Query-string safety** is enforced twice: `api/query.go`'s `resolveColumn` rejects any unknown `filter=`/`sort=` field with a `400` *before* calling into `store/` at all; `store/store.go`'s `physCol` is a second, independent resolver inside `store/` itself. No test in the repo attempts an explicit SQL-metacharacter-injection payload through a filter value or field name — the design is sound by inspection and by the identifier-vs-value discipline above, but that specific property is not regression-tested (see §10, §15).

**Concurrency**: one serialized connection per app; different apps are fully independent files and handles — this is the mechanism behind the documented "one SQLite file per app, physical isolation" invariant.

**PostgreSQL feasibility — concrete, not hand-waved:**
- *Helps*: `schema.App` is fully storage-agnostic. The SQL generated is otherwise standard (`CREATE TABLE`/`ALTER TABLE`/DML) with no exotic SQLite syntax beyond `PRAGMA` calls and the migration engine's table-rebuild strategy. `store.Store`'s method surface (`Insert/GetByID/List/Update/Delete/Exists/RunMigration`) is already small and coherent enough to be a plausible interface boundary.
- *Hurts*: (a) **`store.Store` is a concrete struct, not an interface** — `registry.RegisteredApp.Store *store.Store` is a concrete type imported directly by `api/`, `migrate/`, `sandbox/data.go`, `build/`; introducing a second backend means introducing that interface first, which is real but bounded work. (b) `materialize/` generates SQLite-specific DDL (SQLite's dynamic typing, `CHECK`-based enums, no native `ALTER COLUMN TYPE`) — a Postgres materializer would look substantially different (real column types, native `ALTER TABLE ... ALTER COLUMN`). (c) `migrate/execute.go`'s entire table-rebuild pattern exists *specifically because SQLite can't alter columns in place* — Postgres wouldn't need this 12-step dance for most structural changes (arguably a Postgres executor could be *simpler*), but it means the executor is not portable as-is; a second, Postgres-native executor would be needed, while the **Diff/Classify/Witness decision layers above it are pure schema-diffing logic with zero SQL and would port untouched.** (d) `SetMaxOpenConns(1)`-per-app is a SQLite-specific concurrency strategy that makes no sense against a shared Postgres server; Postgres would want real pooling instead. (e) The "one file per app" physical-isolation model doesn't map cleanly onto one shared Postgres instance — that's a product decision to revisit, not an engineering detail to paper over.
- **Bottom line**: not a small change, but genuinely bounded — the domain model and the migration *decision* logic are already storage-agnostic; only the three SQL-generation layers (`materialize/`, `store/`, `migrate/execute.go`) need parallel implementations behind an interface that doesn't exist yet.

---

## 6. Versioning and Schema Evolution

This is real, tested, forward-only, snapshot-based data preservation — not a placeholder, and it is the part of the codebase most worth preserving unchanged.

**Version representation**: `schema.App.Version int`, sourced from the manifest's `app.version` (`schema/parse.go:25,87`). No separate version-history table exists anywhere in the system; the only durable record of "what version is this app at" is the live `manifest.json` on disk, overwritten in place on a successful migration.

**Pipeline** (`migrate.Apply`, `migrate/apply.go`):

1. **Validate** the new manifest — the same hard gate as boot.
2. **`Diff(oldApp, newApp) *Changeset`** (`migrate/diff.go:19`) — matched **entirely by stable id** (`oldApp.EntityByID(ne.ID)`, `oe.FieldByID(nf.ID)`, `diff.go:28,70`). A field whose id is unchanged but name differs is a rename, not a drop+add, and moves no data.
3. **`Classify(op) Class`** (`migrate/classify.go:16-75`) — an exhaustive switch over every `OpKind`, individually boundary-tested (`classify_test.go`):

   | Operation | Classification |
   |---|---|
   | Add entity, rename entity, rename field | `ClassSafe` |
   | Drop entity, drop field, any reference retarget/`onDelete` change | `ClassDestructive` (unconditional) |
   | Add field | Safe if nullable-or-defaulted; **destructive** if required with no default |
   | Change type | Safe *only* for `integer → real` widening; destructive otherwise |
   | Tighten `required` | Destructive; relaxing it is safe |
   | Add uniqueness | Destructive; dropping uniqueness is safe |
   | Remove an enum value | Destructive; adding values only is safe |
   | anything ambiguous / unrecognized | `ClassDestructive` (default case) |

   Classification reads **only structure**, never a caller-supplied hint — `Operation.Annotation` (`changeset.go:90-93`) is an explicitly documented inert seam (a possible future "model proposes, platform verifies" feature) that `Classify` never reads, confirmed by `TestClassifyIgnoresAnnotation` and `TestAcceptanceMisAnnotationOverridden`.
4. **Confirm + witness gate** (`apply.go:71-82`): `-confirm` is checked first — absent, the whole list of destructive ops is returned as a refusal, nothing runs. Then missing witnesses are checked — same all-or-nothing refusal. No silent coercion, no partial application.

   **Witness vocabulary is narrower than a first read of the README suggests** — only 3 of the ~7 destructive shapes actually require a witness pre-flight (`witnessNeeded`, `witness.go:67-83`): type-narrowing needs `coerce` (`truncate`/`round`/`fail`), and both required-tightening and required-field-no-default-add need `backfill`. **Drops, reference-target/`onDelete` changes, and unique-additions need only `-confirm`, no witness** — their safety is instead enforced structurally at execution time by the rebuilt table's own `CHECK`/`FOREIGN KEY`/`UNIQUE` constraints, which abort the whole transaction if violated. Concretely: **enum-value removal is classified destructive but is *not* witness-gated pre-flight** (`witness.go:63-66`) — a `remap` witness is only actually *needed* if an existing row still holds the removed value, and that's discovered at raw-SQL `INSERT...SELECT` time inside the rebuild, failing the transaction safely rather than being caught earlier. This is a real (though benign — it fails safely, never corrupts) inconsistency between "classified destructive" and "witness required," worth tightening for conceptual integrity, and worth correcting in the README's phrasing.
5. **Snapshot** (`migrate/snapshot.go`) — not SQLite's online backup API, not `VACUUM INTO`: a WAL checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`) followed by a byte-for-byte file copy + fsync, written to `apps/<id>/.snapshots/data-<UTC-ns-timestamp>.db`. Retention defaults to 5 (`DefaultRetention = 5`, `snapshot.go:19`), pruned only after a *successful* migration.
6. **Execute** (`migrate/execute.go`) — one transaction via `store.RunMigration`. A pure rename touches **zero SQL** — the physical column is the field's stable id, so nothing changes at the storage layer; proved by `TestAcceptanceRenameRunsZeroSQL` asserting `PRAGMA schema_version` is literally unchanged. Native `ADD`/`DROP COLUMN` and index ops use direct DDL. Anything SQLite's `ALTER TABLE` can't express — type/nullability/enum/reference changes, required-no-default adds — goes through a table-rebuild: `CREATE TABLE mig_<id>` at the new shape → `INSERT INTO mig_<id> SELECT ...` with a per-column expression handling `coerce`/`remap`/`COALESCE(..., backfill)` → `DROP TABLE <id>` → `RENAME TO <id>` → recreate unique indexes — all inside the one transaction, with `PRAGMA foreign_key_check` run before commit.
7. **Failure handling**: an `Execute` failure rolls back at the SQL level automatically; `apply.go:94-133` additionally restores the file snapshot and **re-registers the prior, unchanged schema** — the registry never observes a failed manifest. This is a genuinely forced test path, not a mock: `TestApplyRestoresOnExecutionFailure` seeds duplicate rows, then adds a UNIQUE constraint so the rebuild's own index creation *actually* fails, and asserts old schema/data/manifest are byte-for-byte untouched afterward.
8. **Reversibility: forward-only, confirmed by absence.** No `Undo`/`Rollback`/`Revert`/`Down` function exists anywhere in `migrate/` (exhaustive grep). The only "undo" is manually restoring a retained snapshot (`TestAcceptanceUndoRestoresByteForByte` demonstrates this is *possible*, not that it's a first-class exposed feature) — there is no computed inverse changeset.
9. **Version history**: not persisted beyond the current manifest and a 5-deep snapshot window. `platform.db`'s tables (`build_jobs`, `active_builds`, `deploy_requests`, `app_meta`) track build/deploy *attempts*, not schema-version history.

**Worked example** — `v1 Expense{id, amount}` → `v2 Expense{id, amount, category}`:

- If `category` is added **nullable or with a default**: `Diff` emits `OpAddField`, `Classify` marks it `ClassSafe`, and `Apply` auto-applies a plain `ALTER TABLE expense ADD COLUMN <category's stable id> ...` — no `-confirm`, no witness, no snapshot.
- If `category` is added **required with no default**: `Classify` marks it destructive; `witnessNeeded` demands a `backfill` witness; without `-confirm` the migration is refused with the full list of destructive ops; with `-confirm` but no witness, still refused; with both, `Apply` rebuilds the table, and the single `INSERT...SELECT` writes `COALESCE(NULL, <backfill literal>)` into every existing row in the same statement — there is no intermediate "add nullable → UPDATE → tighten" sequence, which is architecturally cleaner than a phased approach. This matches `TestEdgeAddRequiredFieldWithDefault` / `TestNullableToNotNullRequiresBackfill`.

**Test coverage**: 9 files, 41 `Test*` functions across diff (8), edge cases (7), witness (6), execute (5), apply (5), acceptance (3), changeset (3), classify (2), snapshot (2) — genuinely deep, and biased toward exactly the properties that matter most (destructive-op refusal, snapshot-restore-on-injected-failure, byte-exact undo, rename-runs-zero-SQL, mis-annotation-ignored). Two concrete, identified gaps: (a) the required-field-no-default rebuild+backfill path is unit-tested for `Classify` in isolation but lacks an end-to-end `Execute` assertion seeding real rows and checking the backfilled values directly (unlike the well-covered tightening/`OpChangeRequired` case); (b) adding uniqueness onto a column that already has duplicate values is untested — its failure mode is presumably a raw `UNIQUE constraint failed` surfaced from index creation, unverified by a dedicated test.

**Boot-time gap worth flagging explicitly**: `registry.Load` (`registry/boot.go:30-33`) documents and implements an explicit assumption — *"v1 boot assumes manifest and `data.db` are already consistent"* — with a literal comment marking the unimplemented seam: `// Seam: migrate(storedManifest, app) would go here before serving.` If a manifest is hand-edited (or otherwise changed) and the server restarted **without** going through `pocketknife migrate` or `build -to` first, the database is not reconciled — new columns simply won't exist, and behavior is undefined rather than a clear error. Migration is invoked explicitly (CLI or `build.Deploy`'s `KindDeploy` path); it is not a boot-time reconciliation step.

---

## 7. API Layer

Routing: stdlib `net/http.ServeMux` with Go 1.22+ method+wildcard patterns (`api/api.go:26-32`) — `POST/GET /apps/{app}/{entity}`, `GET/PATCH/DELETE /apps/{app}/{entity}/{id}`. `resolve()` (`api.go:37-52`) does app/entity lookup (404 on either miss); `requireOp()` (`api.go:55-62`) checks the entity's declared `operations` before any handler body runs (405 on a disabled op).

List query grammar (`api/query.go`): `filter=<field>:<op>:<value>` (repeatable, AND-combined only — no OR, nesting, or joins; ops `eq|ne|gt|gte|lt|lte|like`), `sort=<field>`/`-<field>` (repeatable), `limit` (default 50, capped 200), `offset`. Both filter and sort fields are validated against the schema (declared fields plus `id`/`created_at`/`updated_at`) before ever reaching `store/`.

Body validation (`api/coerce.go`) reuses the field's own constraint rules — required, min/max, enum membership, reference-target existence (via `store.Exists`) — returning `400` with a per-field `Details` list. **This is a separately written implementation, not a shared call into `validate/`** — see §13 for why that specifically matters.

Error envelope: `{"error":{"code","message","details"}}` (`api/errors.go:9-39`). Status mapping: `400` body/query validation, `404` unknown app/entity/row, `405` disabled operation, `409` unique/FK conflict (mapped from `store.ErrUnique`/`store.ErrForeignKey` sentinels via `errors.Is`), `500` default/unexpected — matching the README's table exactly.

**Coupling**: tight but clean in one specific sense and genuinely inline in another. `api/` imports `schema/` and `store/` directly and has no independent business-logic entry point of its own — **CRUD logic is written directly inside the `http.HandlerFunc` closures**, not factored into standalone functions the handlers merely call. Contrast this with `store/`, whose CRUD methods (`Insert/GetByID/List/Update/Delete`) already are transport-agnostic and callable without an HTTP request in sight — proven by `sandbox/data.go`, which calls exactly that surface today for WASM-function data access. The gap for a future non-HTTP caller (MCP, internal Workbench calls) is specifically the *validation/coercion* step, which currently lives only inside `api/coerce.go`.

**Test coverage**: strong — all seven filter operators, `LIKE` case-insensitivity, native FK enforcement, per-entity operation restriction (405), enum/unique/reference constraints, `onDelete: set_null` behavior, and an explicit cross-app isolation test (`TestCrossAppIsolation`) are all directly exercised through a real `httptest` server against real SQLite files.

---

## 8. Runtime and Application Lifecycle

**Created**: via `POST /deploy` with an unknown app id → `build.Bootstrap` (`build/bootstrap.go:29-155`) — stages under a temp name (`apps/.staging-<random>`), materializes, builds/activates the frontend, then atomically `os.Rename`s the staging directory into its final place *before* registering — nothing partial is ever visible. Every failure path before that rename runs through a `fail()` closure that always `os.RemoveAll`s the staging directory. One documented, deliberate exception: if the final job-state transition fails *after* `reg.Register` has already succeeded, the app is left live but the job is reported failed — an intentional asymmetry ("the app is already live... reported but does not roll back"), not an oversight, but worth naming.

**Loaded**: `registry.Load` runs on every process start — a pure re-derivation from disk, no persistent registry cache (confirmed by `TestRestartPersistsDataAndRederivesRegistry`, `TestBootIsIdempotentOnUnchangedManifests`).

**Started/serving**: one `net/http` mux, one OS process, every app served from the same address and the same shared process — apps are not separate processes and do not get separate ports.

**Updated**: `POST /deploy` on a known app id (or `pocketknife build -to`) → `build.Deploy` — `KindInstall` if the manifest version is unchanged (frontend-only rebuild+activate, no data change) or `KindDeploy` if it changed (a full second deploy: snapshot data → `migrate.Apply` → rebuild frontend → activate, one documented rollback contract). **A real, narrow gap was found here**: rollback is explicitly wired for the frontend-build-failure step and the asset-directory-swap step, but a failure in the *later* activating-transition, promote-active, or terminal ready-transition calls returns a bare error with **no compensating rollback**, potentially leaving a job stuck in a non-terminal state with a registry/`platform.db` mismatch (`build/deploy.go`, roughly lines 145–190). This directly narrows the "single rollback contract" claim and is worth closing before any automated (non-human-supervised) deploy pipeline sits on top of it.

**Stopped**: process exit; on the *next* boot, `build.Reconcile` (`build/reconcile.go:31`) fails any build job that was mid-flight when the process died, and reattaches each app's durable `active_builds` pointer (or marks it broken / serves that app API-only if the pointer or its asset directory is stale or missing).

**Deleted**: **no app-deletion operation exists anywhere in the codebase** — confirmed across `api/`, `build/`, `deployapi/`, `platform/`. Removing an app today means manually deleting its `apps/<id>/` directory; there is no lifecycle hook to also purge its rows from `platform.db`.

**Isolation**: physical at the filesystem level (one `data.db` per app, one `*sql.DB`/`MaxOpenConns(1)` handle per app), but **all apps share one OS process and one address space** — no process isolation, no network/port isolation (`/apps/{app}/...`, `/ui/{app}/...` are path-namespaced under one origin, not separate ports). Per-app-id concurrency serialization for *deploys* exists only inside `deployapi.Server` (a `sync.Mutex` map, `deployapi.go:40-66`) — it does not extend to the `build` package itself or to the `pocketknife build` CLI, which has no internal locking of its own (confirmed by grep: no `sync.Mutex` in non-test `build/*.go`).

**Filesystem layout** (reconstructed from code + git history, since the working `apps/` tree is currently absent — see the note at the top of this document): `apps/<id>/{manifest.json, data.db (+ -wal/-shm, gitignored, runtime-created), <frontend.dist>/ (the raw bundle just written by /deploy), builds/<jobID>/ (immutable per-job copy of the activated bundle, retention 5), sources/<jobID>/ (optional editable frontend-source tar, 1:1 with a build job), .snapshots/data-<ts>.db (migration snapshots, retention 5)}`. `platform.db` (+ `-wal`/`-shm`) lives at the repo root by default, path overridable via `-platform-db`.

---

## 9. Error Handling and Observability

**Propagation**: idiomatic Go `error` returns throughout; sentinel errors (`store.ErrUnique`, `store.ErrForeignKey`) are the one deliberate typed-error mechanism, mapped to HTTP status via `errors.Is` at the API boundary. Each of `validate/`, `api/`, `build/`, `deployapi/` independently defines its own small error-envelope struct (`validate.Error`; `api/errors.go:9`; `build/http.go:16`; `deployapi/deployapi.go:180`) rather than sharing one type — `build/http.go`'s duplication is explicitly commented as deliberate ("decouple evolution of the two"), the others are simply independent implementations of the same shape.

**Logging**: `log.Printf`/`log.Fatalf` to stdout/stderr only, and used sparingly — confirmed present in only `cmd/pocketknife/main.go`, `platform/plan.go`, `build/bootstrap.go`, and `deployapi/deployapi.go`. Packages `store/`, `materialize/`, `migrate/`, `validate/`, `registry/`, `sandbox/`, `broker/`, `consent/`, `api/` do **no** server-side logging at all — a failure in any of them surfaces only as a returned Go error / HTTP error body, with no log trail if the immediate caller doesn't log it. There is no request-logging middleware anywhere, so requests to `/apps/`, `/deploy`, `/ui/`, `/export/`, `/builds/` are never logged by the server itself.

**Panic handling**: **zero `recover()` calls anywhere in the non-test codebase**, and no panic-recovery middleware wraps any HTTP handler. Because this is one process serving every app (the documented "no per-app process" invariant), an unrecovered panic in any single request handler — in `api/`, `build/`, `deployapi/`, or `platform/` — would crash the entire server for every app, not just the one that triggered it. (One intentional `panic` exists at `store/ids.go:23` for a `crypto/rand` failure during ID generation, treated as fatal-and-unreachable-in-practice, which is a reasonable choice for that specific case — it's the *absence of any recovery layer above it* that's the finding.)

**Tracing/metrics/health checks**: none exist — no `slog`/structured logging, no Prometheus/`expvar` metrics, no OpenTelemetry tracing, no `/health` or `/ready` endpoint. `GET /builds/{app}` and `GET /builds/job/{id}` are the closest thing to observability that exists, and they're build-job-specific, not general health probes.

**Where failures would be hardest to diagnose today**: (a) any `500` on a busy server, with no request-id or correlated log line to connect it back to a request; (b) the SSE plan-session's `Last-Event-ID` replay — a linear scan against a rolling 50-event buffer that, once it has evicted the requested index, silently replays *nothing* rather than erroring, which would present to a user as "the agent said something I never saw"; (c) the post-activation-failure window in `build.Deploy` (§8) — a job reported `failed` while the app is actually live is exactly the kind of state that's hard to reconcile without a dashboard; (d) a plausible but unverified boot-crash trigger in `build.Reconcile`'s durable-completion shortcut (`reconcile.go:44`), which calls `Transition(j.ID, StateReady, "")` directly from a `queued`/`building` state when an `active_builds` pointer already matches — but `Transition`'s allowed-state map (`build/store.go:38-44`) does not obviously permit a direct `building → ready` jump, and a resulting `ErrInvalidTransition` would propagate as a **boot-fatal `log.Fatalf`** (`main.go:120-123`). This is flagged from static reading, not reproduced; it's worth a targeted repro test before it's trusted either way.

**TODO/FIXME/XXX**: zero matches anywhere in the non-test, non-agent, non-shell Go source. Either the codebase is unusually complete for its size, or incompleteness is deliberately tracked out-of-band (`openspec/`) rather than left as inline markers.

---

## 10. Testing

**Behavioral confidence is genuinely high on the core request path and the migration engine, thin on `store/` and `schema/` directly, and — because there is nothing to test — necessarily zero on the sandbox's *production* wiring, since none exists.**

Style is predominantly integration-grade throughout: real temp-dir SQLite files, real `httptest` servers, and — for `sandbox/` — a real wazero WASM runtime driving an actual compiled guest module (not a mock), which makes `sandbox_test.go` the slowest test file in the repo by a wide margin.

**Zero test files**: `schema/`, `shellserve/`, `cmd/pocketknife/`. `schema/` is the single most load-bearing package in the system (every other package depends on its correctness) and having no direct tests of `Parse`'s error paths or `normaliseDefault` is disproportionate to its importance — it's exercised only indirectly today, via `validate/` and `api/` integration tests. `cmd/pocketknife/main.go`'s flag wiring, `.env` loading, and subcommand dispatch are also untested.

**Thin**: `store/store_test.go` has exactly one direct test (`TestForeignKeysPragmaEnabled`) — its CRUD/filter/sort/pagination SQL-building is validated only indirectly, through `api/`'s and `migrate/`'s integration tests. `materialize/` is targeted but narrow: platform columns, type mapping, FK clauses, and enum-quote-escaping are each directly asserted, and idempotency is checked at the DDL-*syntax* level (the `IF NOT EXISTS` substring is present) rather than by executing the DDL twice against a live database inside the package itself.

**Deep**: `migrate/` (9 files, 41 tests — see §6), `api/` (all 7 filter operators, cross-app isolation, FK/enum/unique constraints, `onDelete` behavior), `registry/` (restart-preserves-data, physical-isolation, boot-idempotency, invalid-manifest-skipped), `build/` (11 files — the largest test investment after `migrate/`; forced real failures include a genuine mid-second-deploy frontend-build failure proving rollback, `build/deploy_test.go:165`, and genuine `Bootstrap` cleanup on failure leaving zero partial app, `bootstrap_test.go:87`), `sandbox/` (24 tests, including capability-denial-carries-no-oracle-payload and filesystem/env/raw-socket-always-fail negatives), `deployapi/` (tar-bundle path-traversal/symlink/absolute-path rejection, each with a dedicated test, `bundle_test.go:104,116,125,134`).

**`go vet ./...` is clean.** `test_project_hub.sh` (repo root) is a manual, non-`go test` end-to-end smoke script — curl+jq against a live server exercising the `project_hub` example app's full CRUD+relationships — useful but not wired into `make test` and not hermetic.

**Highest-value missing tests, in priority order**:
1. An explicit SQL-metacharacter-injection attempt at the `api/`/`store/` boundary — currently a sound-by-inspection property, not a regression-tested one.
2. Direct unit tests for `schema.Parse`'s error paths and `normaliseDefault` — the most load-bearing package in the repo, currently exercised only indirectly.
3. An end-to-end `migrate.Execute` test for the required-field-no-default rebuild+backfill path, seeding real rows and asserting the backfilled values (the analogous tightening case is well-covered; this specific shape isn't, end-to-end).
4. A boot-time test proving what happens when a manifest changes shape without a migration having been run first (§6's "Seam" gap) — today the behavior is an unspecified inconsistency rather than a clear, tested error.
5. A repro test for `build.Reconcile`'s possible invalid-state-transition boot crash (§9).
6. `OpChangeUnique` tightening against pre-existing duplicate values (untested failure mode).
7. A test of the post-activation no-rollback window in `build.Deploy` (§8).

---

## 11. Security Review

**SQL injection — no exploitable path found.** Identifiers reaching SQL text are always schema-model stable ids, gated by the `^[a-z][a-z0-9_]*$` regex inside `validate.Manifest` before they ever reach `materialize/` or `store/`; neither of those packages re-validates independently — they explicitly trust the upstream gate (§5). This is currently safe and correct, but it is a single point of trust worth naming for anyone adding a new manifest-ingestion path later: if any future caller reaches `materialize.Statements` or `store`'s column-resolution logic with a manifest that skipped `validate.Manifest`, identifier safety silently disappears. Values are always bound parameters, with one narrow, correctly-escaped exception (enum `CHECK` literals — schema constants, never row data).

**Path traversal**: two independently correct defenses. `build.ExtractBundle`'s `safeJoin` (`build/bundle.go:101-111`) rejects absolute paths and re-checks that the cleaned join still has the base-directory prefix (catching multi-segment `..` climbs); only regular files and directories are accepted from the tar stream — symlinks, hardlinks, and devices abort the *entire* extraction rather than being silently skipped (`bundle.go:62-77`). `assets.NewServer` (`assets/assets.go:47`) and `shellserve/shellserve.go:30` both prefix the request path with `/` and run `filepath.Clean` before joining, so a `..` collapses at the root before it can escape the asset directory.

**Zip-bomb / bundle-size DoS**: `MaxBundleEntries=10000` and a `MaxBundleBytes=200MiB` cap are enforced incrementally during extraction, plus an outer `http.MaxBytesReader` on the whole `/deploy` request body. **One specific, real bypass was identified**: the cumulative-size check compares against the tar entry's *declared* `hdr.Size` header before writing it, but the subsequent `io.Copy` writes whatever the tar stream actually yields for that entry with no post-copy verification against the declared size — a crafted entry with a falsified small `Size` header could in principle exceed `MaxBundleBytes`. This is currently mitigated in the one live caller (`/deploy`, via the outer request-body cap) but is **not** mitigated for any other caller of `ExtractBundle`, including a future direct CLI or API use — worth closing at the source rather than relying on an outer limit that happens to exist today.

**Symlink-escape, second line of defense missing**: the path-traversal guards above block `..`-climbing but neither `assets/` nor `shellserve/` does an `Lstat`/realpath check before serving a file — a symlink placed *inside* an already-activated asset directory could point outside it and be served. Low likelihood in practice (it would require an already-successful deploy, and `ExtractBundle` already rejects symlinks during extraction), but it's a second, independent line of defense that doesn't currently exist.

**Command injection**: the one production `exec.Command` call site (`platform/plan.go:176`, spawning the agent subprocess) passes the prompt and app id as discrete argv elements, never through a shell — Go's `exec.Command` doesn't invoke `/bin/sh`, so standard shell-metacharacter injection is not possible via this path even with fully free-text user input.

**Secrets**: `POCKETKNIFE_ADMIN_PASSWORD` is read once via `os.Getenv` (`platform/auth.go:95`), immediately bcrypt-hashed (`DefaultCost`), never logged, never written to disk; if unset, a random password is generated and printed once. The model-provider token (`broker/`) is held on an unexported struct field with no accessor and no `String()`/`MarshalJSON` method — but this code path (§12) is **never actually constructed in production**, so "secrets handling" for the model broker is currently a property of tested-in-isolation library code, not of the live system.

**Session auth**: bcrypt password hashing, `HttpOnly`+`SameSite=Strict` cookie, a 24h server-side session with sliding renewal, a ≥200ms floor applied uniformly on any login failure (so it doesn't leak which credential was wrong). Sessions are pure in-memory (`map[string]time.Time`) — lost on restart, and not shared across instances; acceptable for a single-admin self-hosted tool, a blocker for horizontal scaling (§14). One cosmetic gap: the cookie's `MaxAge` is fixed at issuance while the server-side expiry slides, so the two can drift near the 24h boundary — not a security hole (the cookie value doesn't encode expiry), but a real consistency bug.

**Authentication boundary — a broader gap than the README states.** The README calls out `POST /deploy` as unauthenticated by design. In code, that's true, and `GET /export/` shares the same gap (neither is routed through `platformServer`, which only wraps `/platform/` — `main.go:151-160`). **But the entire data-plane CRUD API (`api.NewServer`, everything under `/apps/`) has no session/auth check anywhere in `api/*.go` either** — confirmed by grep for `session|auth|cookie` across that package returning nothing outside test-file noise. So it isn't just the deploy-ingest path that's open: `/apps/`, `/builds/`, `/ui/`, and `/export/` are *all* reachable by anyone who can reach the port, with only `/platform/` behind auth. This is internally consistent with a single-tenant, local-first trust model (one machine, one admin, no browser-facing untrusted network) and is explicitly acknowledged for `/deploy` — but it is a hard blocker, not a config flag, for any multi-tenant or hosted mode, and is worth stating in exactly these terms rather than only as "the deploy endpoint is open."

**Cross-app data access**: structurally impossible, not just policy — separate SQLite files per app, confirmed at the HTTP layer by `TestCrossAppIsolation`.

**Sandbox as an isolation boundary**: strong when it matters. wazero WASM with no filesystem/environment/raw-socket access (explicitly tested: `TestFilesystemAccessAlwaysFails`, `TestEnvironmentIsAlwaysEmpty`, `TestRawSocketDialAlwaysFails`, `TestGuestOnlyImportsHostAndWASI`), fixed memory/timeout/input-output-byte caps enforced before any resource is touched, and a deliberate confused-deputy mitigation (outbound redirects are never followed — `httpClient()`'s `CheckRedirect` always returns `http.ErrUseLastResponse`, `invoke.go:81-83`, verified by `TestNetworkFetchDoesNotFollowRedirects`) so an allow-listed host can't redirect a call to a non-allow-listed one. Denial responses for all three gated host calls (`data_call`, `network_fetch`, `model_call`) carry zero payload on denial (`codeDenied`, `host.go:161-171`), closing the oracle side-channel a function could otherwise use to probe for capabilities it wasn't granted. The one soft spot: resource-exhaustion classification is a substring match on the wazero panic message (`"mallocgc"`, `"fatalthrow"`, `"out of memory"`) rather than a typed error — brittle across wazero version upgrades, though it only affects error *classification*, not the memory cap's actual enforcement. Its only real weakness today is that **it is unreachable from any HTTP path** (§12) — a wiring gap, not a security gap in the sandbox itself.

**Not reviewed / out of scope for this pass**: the `agent/` TypeScript process itself (prompt-injection-via-pasted-code is explicitly named as a real, known risk in the project's own design document and was not independently re-verified here) and the shell SPA's client-side code.

---

## 12. Suitability for Workbench

Workbench's target shape (*Agent App → Skill / MCP tools / persistent state / UI / metadata → Runtime → SQLite/Postgres/other infra*) maps onto pocketknife's existing division of labor well **for the state/runtime layer specifically** — which is exactly the scope this engine already occupies.

### A. Reusable unchanged
- `schema/` — the domain model, zero framework coupling. This is the strongest single asset for a Workbench pivot: a "portable agent app" manifest concept needs exactly this underneath it.
- `store/`'s CRUD/list primitives and its identifier-vs-value discipline, as a pattern (and, once behind an interface, as a literal SQLite implementation).
- `migrate/` in its entirety — the decision layers (`Diff`, `Classify`, the `Witness` vocabulary) contain zero SQL and would port to any backend untouched; the whole subsystem is genuinely rare, hard-won engineering that most systems this size never build.
- `validate/`'s two-layer structural-then-semantic pattern and its structured error shape.
- The sandbox's isolation *design* — wazero + capability-checked host ABI + a brokered, guest-unreachable token — reusable as-is the moment it has a caller.

### B. Should be refactored
- `api/`'s inlined CRUD-in-HTTP-handler pattern needs its core logic (create/read/update/delete/list plus body coercion) pulled up into transport-agnostic functions the HTTP handlers merely call — the direct prerequisite for §13's MCP end-state.
- **Field coercion/validation is independently reimplemented at least twice** — `api/coerce.go` (HTTP bodies) and `sandbox/data.go`'s `coerceValue` (WASM `data_call` inputs, deliberately not importing `api/` to avoid a cycle) — plus a third, structurally similar but narrower implementation in `validate/semantic.go`'s `validateDefault` (manifest-default validation only). A bug fix or new field-type rule applied to one will silently not apply to the others; this should be unified into one shared function before a third or fourth transport (MCP, an internal call surface) is added on top.
- `store.Store` needs an interface boundary before Postgres is even worth discussing — today it's a concrete struct with SQLite-specific connection semantics (`SetMaxOpenConns(1)`) baked directly in.
- Per-app-id deploy concurrency safety currently lives only in `deployapi`'s private mutex map, not in `build` itself — it should move down into `build/` so any future caller (an MCP tool, a scheduler, a direct CLI invocation) gets the same safety for free.
- `build.Deploy`'s post-activation no-rollback window (§8) should get either a compensating action or a clearly surfaced "activated but bookkeeping failed" alert path.
- Auth needs to move from single-admin/in-memory-session toward whatever Workbench's real multi-user model turns out to be — a genuine redesign, not a patch, and the codebase's own design document never pretended otherwise.

### C. Should probably be removed, or explicitly re-scoped
- The specific shell-SPA-plus-Claude-agent-bridge-over-SSE-over-subprocess mechanism, *if* Workbench's agent-app model is going to be MCP/Agent-Skills-native — this bridge is a bespoke, proprietary protocol (`docs/bridge-protocol.md`) predating MCP as the stated target, and doesn't need deleting immediately, but isn't the direction Workbench wants to converge on either.
- Nothing in the Go engine itself reads as pure accidental cruft — the closest candidates are inert seams (`Operation.Annotation`) that are fine to leave as documented future hooks rather than delete.
- The sandbox/broker/consent trio is **not** dead code and shouldn't be removed — it's unwired, which is a different problem with a different fix (wire it up — see D).

### D. Missing capability
- **A transport-agnostic domain-operation layer.** The generic CRUD surface exists only as `net/http` handlers today; there is no internal Go function boundary that both `api/` and a future MCP server (or direct internal Workbench call) could share without duplicating validation logic.
- **The sandbox has no caller.** `sandbox.Invoke`, `broker.New`/`NewHTTPCaller`, and `consent.Union` are fully built and tested but have zero production call sites anywhere in the repo (`main.go` imports none of them; no HTTP route triggers a function invocation). This is the single most consequential "missing capability" finding in this review, because it's easy to read the README and believe sandboxed tool execution already works end-to-end — it doesn't yet, only its building blocks do.
- **No app-deletion/purge lifecycle** across `data.db`, `platform.db` rows, and on-disk build artifacts.
- **No manifest-version-history or audit log** beyond a 5-deep rolling snapshot window.
- **No multi-tenant/workspace concept anywhere** — not partially built, not stubbed, genuinely absent at every layer (registry, `platform.db`, HTTP routing). Consistent with the stated single-user design, but 100% new work for Workbench, not a refactor.

**Against the specific dimensions asked about:**
- **Multiple installed apps** — solid; already the default operating mode (a registry keyed by app id, one file per app).
- **App isolation** — physical (separate SQLite files) and process-internal (separate `*sql.DB` handles), but not OS-process or network isolation; fine for local-first, insufficient alone for multi-tenant SaaS.
- **Declarative data schemas / schema evolution** — the strongest part of the codebase by far, genuinely production-grade.
- **Tool execution** — built but disconnected; wiring it up is scoped integration work, not a redesign.
- **MCP exposure** — see §13; mixed readiness, but the missing piece is small and well-understood.
- **Future PostgreSQL** — real, bounded work concentrated in exactly three packages (§5).
- **Local-first** — this is precisely what exists today.
- **Hosted/SaaS** — the in-memory session store, single-admin auth model, and one-process-serves-everything design would all need real rework; genuinely new architecture, not an extension of what's here.

---

## 13. MCP Readiness

**The separation between transport and domain logic is partial — and the partial-ness is informative, not fatal.**

What already works as a domain-logic entry point independent of `net/http`, proven by an existing non-test, non-HTTP caller:

```go
func (s *Store) Insert(ent *schema.Entity, values map[string]any) (map[string]any, error)             // store/store.go:197
func (s *Store) GetByID(ent *schema.Entity, id string) (map[string]any, error)                        // store/store.go:217
func (s *Store) List(ent *schema.Entity, q ListQuery) ([]map[string]any, int, error)                  // store/store.go:269
func (s *Store) Update(ent *schema.Entity, id string, values map[string]any) (map[string]any, error)  // store/store.go:305
func (s *Store) Delete(ent *schema.Entity, id string) (bool, error)                                    // store/store.go:331
```

This is **not hypothetical** — `sandbox/data.go`'s `dataCreate/dataRead/dataList/dataUpdate/dataDelete` already call exactly this surface today, driven by a `registry.App(id)`-obtained `(*schema.Entity, *store.Store)` pair, with no HTTP object anywhere in the call chain. This is a working, tested precedent for a non-HTTP caller doing full CRUD — today the caller is a WASM guest function; tomorrow it could equally be an MCP tool.

**What's missing**: the input-validation/coercion step (`required`/`min`/`max`/enum-membership/reference-existence checks) is not shared — it's independently reimplemented in `api/coerce.go` (for HTTP bodies) and again in `sandbox/data.go`'s `coerceValue` (for WASM `data_call` inputs, explicitly duplicated rather than imported specifically to avoid an import cycle into `api/`), plus a third, narrower version in `validate/semantic.go` (manifest-default validation only). An MCP tool calling `store.Insert` directly today would either need a *fourth* copy of this logic, or — the right move — `coerce`/`coerceValue` should be unified into one function in a neutral package that `api/`, `sandbox/`, and a future `mcp/` package all import.

**Would MCP need to call the HTTP API today, or can it call the domain layer directly?** It would currently have to go through HTTP, purely because the reusable logic (query parsing aside) is written inline inside `net/http.HandlerFunc`-shaped closures rather than factored into standalone functions — not because the underlying pieces (`store/`, `schema/`, most of `api/coerce.go`) are actually entangled with HTTP. This is a small, mechanical extraction, not an architectural rewrite: pull `api/api.go`'s handler bodies into plain Go functions (`func CreateRow(ent *schema.Entity, st *store.Store, body map[string]any) (map[string]any, error)`-shaped) that the HTTP handlers then thinly wrap.

**Existing MCP precedent in this codebase, worth noting explicitly**: the `agent/` Node process already runs its own in-process MCP server exposing two tools (`validate_manifest`, `ready_to_build`) to its own planning session (per `agent/FLOW.md`). That's a working pattern for "expose a Go-backend-adjacent operation as an MCP tool" — it's just currently scoped to the agent's own authoring loop, not to the runtime's CRUD surface. There's an existing template to follow, not a green field.

**Preferred end-state, and it's practically reachable without a rewrite:**

```
                 ┌── HTTP API (api/, thin wrapper)
Domain layer ────┼── MCP tools (thin wrapper, same domain calls)
(store/ + schema/ └── internal Workbench calls (direct Go calls)
 + one shared
 coerce function)
```

This is achievable specifically *because* `store/` and `schema/` are already transport-agnostic and `sandbox/data.go` already proves the "call `store.Store` directly, no HTTP" pattern works. The refactor is: (1) unify the duplicated coercion logic into one shared function, (2) extract `api/api.go`'s handler bodies into plain functions over that shared function plus `store.Store`, (3) write a thin `mcp/` package whose tools (`create_<entity>`, `list_<entity>`, etc. — one per allowed operation per entity, analogous to how `client.Generate` already renders one TypeScript method per allowed operation) call the same functions. None of `store/`, `registry/`, or `schema/` needs to change for this — this is *not* the `MCP → HTTP → Engine` anti-pattern the brief asks to avoid; the pieces to call directly already exist, they're just not yet collected behind one shared boundary.

---

## 14. Deployment Model

**Local dev** (a `docker compose up`-style topology with a Workbench frontend, an agent service, this Go engine, and a Postgres control database, app data in SQLite): plausible with modest effort. The binary is already close to self-contained — pure-Go SQLite driver (no cgo), boots from a `.env` file or the environment directly, and the `-cors` + separate Vite dev server pattern already documents a two-process dev mode. Three concrete friction points, in order of how soon they'd bite:

1. **`platform.db` sessions are in-memory only** (`platform/auth.go`) — a container restart during dev (or any multi-instance topology) logs everyone out; would need a persisted or shared session store before this stops being purely a dev-mode inconvenience.
2. **The agent is spawned as a subprocess of the Go server** (`exec.Command`, `platform/plan.go:176`) — in a multi-container topology, "the Go server shells out to a Node process on the same filesystem" is an awkward shape; it would need to become a network call to an agent *service* instead, which meaningfully changes `platform/plan.go`'s SSE-bridging code, not just its config.
3. **`/deploy` (and `/export/`, and the entire `/apps/` data plane per §11) being unauthenticated** is fine behind a fully private Docker network today, but becomes a real exposure the moment any container's port is reachable from outside that network — worth closing before, not after, any topology where the Go engine's port is anything but strictly private.

**Future hosted/SaaS** — architectural choices that are specifically single-tenant/single-process assumptions today, and would need to be *revisited*, not merely extended:

- In-memory session store — no shared state across instances, no stateless-token alternative (JWT-style) currently exists.
- One process serves every app with no per-app resource governance — horizontal scaling today means "run more identical copies of the whole registry," not "shard apps across instances," because there's no app-to-instance ownership/routing concept anywhere.
- `SetMaxOpenConns(1)` per app `data.db` is a deliberate, appropriate single-writer-per-file choice for a self-hosted personal box; it does not extend to "many users' apps behind a load balancer" without a different storage story per app — which is exactly the Postgres question from §5, and the two questions (multi-tenancy and Postgres) are coupled, not independent, so they should be decided together.
- No workspace/tenant concept exists at any layer (registry, `platform.db`, or HTTP routing) — this is the single largest gap between what exists and what a hosted Workbench needs, and it's genuinely absent rather than partially built.
- No stateless/stateful split exists — the binary is monolithic (API + build engine + session store + agent-bridge spawner, all one process). A SaaS topology would likely want to separate "serve app API traffic" (stateless, horizontally scalable, needs shared Postgres) from "run builds/migrations" (inherently serialized per app, fine as a singleton or leader-elected component) — today there's no seam drawn between those two responsibilities anywhere in the code.

None of this is a design failure — `docs/pocketknife-design-context.md` states the self-hosted, single-user posture as an explicit, considered choice. It just means "hosted SaaS" is new architecture for Workbench to design from scratch, with this engine supplying the state/schema/migration primitives underneath it, not the multi-tenancy story itself.

---

## 15. Technical Debt and Risks

### Critical
1. **The entire data plane (`/apps/`) plus `POST /deploy` and `GET /export/` are unauthenticated.** Only `/platform/` sits behind session auth (`main.go:151-160`; confirmed by grep across `api/*.go` finding no session/auth/cookie check at all). This is broader than the README's framing of "just the deploy endpoint" — anyone who can reach the port can read or write any app's data, and install or overwrite any app. Must be closed before this runtime is exposed to anything beyond a fully private network; this is precisely the ingest and data path Workbench would reuse for agent-authored apps.
2. **The sandbox/broker/consent subsystem has zero production callers.** If Workbench's pitch includes "sandboxed tool execution," today that's aspirational infrastructure, not a working feature — the isolation is real and well-tested, but nothing invokes it. Decide explicitly (wire it up, or scope it out of v0.1 and say so) rather than leaving it in a state that reads as done from the README alone.
3. **Boot-time manifest/data.db consistency is an unenforced assumption**, with the gap literally marked in a comment (`registry/boot.go:30-33`, "Seam: migrate(...) would go here"). A manifest that changes shape outside the CLI-driven migrate/build flow produces silently undefined behavior rather than a clear error.
4. **`build.Deploy`'s rollback contract has a real hole** in its later activation steps (§8) — a job can get stuck non-terminal with a registry/`platform.db` mismatch, directly narrowing the documented "single rollback contract" invariant.
5. **No panic-recovery layer anywhere** — an unrecovered panic in any single request handler crashes the entire server for every app (§9), a direct and avoidable consequence of the shared-process design.

### Important
6. **Field coercion/validation is duplicated across at least two, arguably three, independent implementations** (`api/coerce.go`, `sandbox/data.go`'s `coerceValue`, `validate/semantic.go`'s narrower `validateDefault`) — a silent-drift risk today and the direct blocker to clean MCP exposure (§13).
7. **`store.Store` is a concrete type, not an interface** — blocks Postgres and blocks easy test-doubling of storage.
8. **`OpChangeEnum` removal is classified destructive but not witness-gated pre-flight** (§6) — currently fails safely at raw-SQL time, but the inconsistency between "classified destructive" and "witness required" is worth closing before more operation types are added to the classifier.
9. **`build.ExtractBundle`'s cumulative byte-cap can be bypassed** by a tar entry with a falsified `Size` header (§11) — low severity today given the one live caller's outer request-size limit, but a latent trap for any future direct caller.
10. **No structured/correlated logging, no health/readiness endpoints** — makes production operation harder to diagnose than the code quality elsewhere in the system would suggest.
11. **In-memory-only session store** — doesn't survive restarts, doesn't scale horizontally; fine for today's stated single-user scope, a hard blocker the moment multi-instance or hosted deployment is on the table.
12. **No app-deletion/purge lifecycle** across `data.db`, `platform.db` rows, and on-disk build artifacts.
13. **`schema/` has zero direct tests** despite being the most load-bearing package in the repo.

### Later
14. Cookie `MaxAge` vs. server-side sliding-expiry drift near the 24h boundary (cosmetic).
15. SSE `Last-Event-ID` replay can silently under-replay once the 50-event buffer has evicted an index (soft correctness gap for long-lived reconnecting clients).
16. Symlink-escape defense-in-depth is missing in `assets/`/`shellserve/` (currently relies entirely on `ExtractBundle` having already rejected symlinks upstream).
17. `Operation.Annotation` — a documented, currently-inert extension point; fine to leave, worth remembering it's there if an LLM ever starts proposing changesets directly.
18. No explicit SQL-injection-attempt regression test, despite the underlying design being sound by inspection.
19. A plausible (unverified) boot-crash trigger in `build.Reconcile`'s state-transition shortcut (§9) — worth a targeted repro test to settle either way.
20. `apps/*/{builds,dist,sources}` build artifacts are checked into git in the committed history — repo hygiene; will keep growing with every deploy unless excluded going forward.

---

## 16. Recommended Stabilization Plan

**Explicitly not a rewrite.** The core (`schema/validate/materialize/store/api/registry`) and the migration engine are the strongest assets in this repository; this plan is about closing real gaps and building one clean seam for Workbench, not re-architecting what already works.

### Phase 1 — Understand and lock behavior
- Write the missing direct tests for `schema/` (it has none, and everything else depends on it) and add an explicit SQL-injection-attempt regression test at the `api/`/`store/` boundary — both are cheap and close disproportionate risk relative to package importance.
- Add the two identified `migrate/` coverage gaps: an end-to-end `Execute` test for the required-field-no-default rebuild+backfill path, and a test for `OpChangeUnique` tightening against pre-existing duplicate data.
- Add a repro test for `build.Reconcile`'s possible invalid-state-transition boot crash (§9) to settle whether it's a live risk.
- Restore or embed a minimal `apps/` fixture set so `api/` and `build/acceptance_test.go` run again in this checkout — right now a meaningful fraction of the integration-test signal is unavailable locally.
- Write down, in one place, the *actual* per-operation-kind witness requirements (§6) — the README currently overstates them, which will mislead anyone building tooling against the migrate/build witness contract.

### Phase 2 — Fix blockers
- Close the data-plane and `/deploy`/`/export` auth gap (Critical #1) — this is the highest-priority item before any traffic beyond a trusted local network touches this engine.
- Close the boot-time manifest/data.db consistency gap (Critical #3) — turn the silent inconsistency into a loud, clear boot-time error.
- Close the `build.Deploy` post-activation rollback gap (Critical #4).
- Add a minimal panic-recovery middleware wrapping every HTTP handler (Critical #5) — cheap, and directly limits blast radius on the "one process, no isolation" design.
- Decide sandbox/broker/consent's fate explicitly (Critical #2): wire `sandbox.Invoke` into one real call path, or mark the subsystem experimental/deferred in the README so nobody assumes tool execution already works end-to-end.
- Fix the `ExtractBundle` byte-cap bypass (§11/#9) at the source rather than relying on the outer request-size limit that happens to cover it today.
- Unify the duplicated coercion implementations (Important #6) — a correctness fix in its own right, and the direct prerequisite for Phase 3's MCP work.

### Phase 3 — Create clean runtime boundaries (only what Workbench actually needs)
- Extract a transport-agnostic domain-operation layer out of `api/api.go`'s handler bodies (create/read/update/delete/list as plain Go functions over `*schema.Entity`/`*store.Store` plus the now-unified coercion function) — the one refactor that unlocks the `HTTP ⟂ MCP ⟂ internal calls` end-state from §13, using `sandbox/data.go`'s existing pattern as the proof this works without touching `store/`, `registry/`, or `schema/`.
- Introduce a minimal `Store` interface around the current SQLite implementation's existing method set (`Insert/GetByID/List/Update/Delete/Exists/RunMigration`) — not a Postgres implementation yet, just the seam, so that question can be answered deliberately later rather than by accident now.
- Move per-app-id build/deploy serialization down into `build/` itself, out of `deployapi`'s private mutex map, so any future caller inherits the same safety automatically.
- Build a thin `mcp/` package as transport shims over the new domain layer, one tool per allowed operation per entity — additive, not a rewrite, given the domain layer and the `sandbox/data.go` precedent already exist.

**Explicitly not recommended for v0.1**: a Postgres implementation itself (only the interface seam), multi-tenant/workspace auth, per-app process isolation, or any other speculative "future SaaS" scaffolding — none of it is needed to make this engine a reliable state/runtime layer for a local-first Workbench v0.1, and building it now would be exactly the kind of premature abstraction this review was asked to avoid recommending.

---

## 17. Final Assessment

**Stabilize, then a targeted partial refactor.** Not reuse-as-is — the data-plane/deploy auth gap and the boot-time consistency gap are real, closeable risks that shouldn't ship into Workbench unexamined. Not a rewrite — the core derive pipeline and the migration engine are exactly the kind of hard-won, well-tested engineering that a rewrite would either take months to reproduce, or more likely reproduce worse. And the refactor that *is* needed (coercion unification, a storage interface seam, extracting a domain layer out of `api/`) is narrow and well-scoped, not a broad rearchitecture.

### Strongest parts of the existing engine
1. The migration engine (`migrate/`) — stable-id diffing, a hint-proof safe/destructive classifier, witness-gated destructive operations, snapshot/restore-on-failure — all closely matching its own documentation and unusually well-tested for exactly the properties that matter (destructive-op refusal, snapshot-restore under a genuinely forced execution failure, byte-exact undo).
2. `schema/` as a genuinely transport- and storage-agnostic domain model — precisely the property Workbench needs from whatever it keeps as its state layer.
3. Disciplined identifier-safety design — stable ids, gated once at the validation boundary, are the only things that ever reach SQL text — a specific, correct, well-understood answer to a specific, real risk.
4. The sandbox's isolation design (wazero + capability-checked host ABI + a brokered, guest-unreachable token) — architecturally sound and rigorously tested, even though currently unwired.
5. Physical per-app data isolation and atomic-rename-into-place staging in `build.Bootstrap` — two simple mechanisms that structurally eliminate entire classes of bugs (cross-tenant data leakage, partially-registered apps) rather than merely mitigating them.

### Biggest risks
1. The data plane and deploy-ingest path are unauthenticated — broader than the README's framing, and exactly the surface Workbench would reuse for agent-submitted apps.
2. The sandbox/broker/consent subsystem is fully tested but completely unwired — easy to mistake for "done" from documentation alone.
3. Field coercion/validation logic is duplicated across implementations with no single source of truth — a silent-drift risk and the direct blocker to clean MCP exposure.
4. No multi-tenancy/workspace concept anywhere, coupled to a SQLite-only, single-writer-per-file storage model — the largest true gap between what exists and what a hosted Workbench needs, and as much a product decision as an engineering one.
5. No panic recovery in a single shared process serving every app — one bad request handler can take down every app at once.

### First five concrete engineering tasks, in order
1. Close the `/apps/`, `/deploy`, `/export/` authentication gap (or explicitly scope this engine to a trusted-network-only deployment and document that as a hard constraint).
2. Add a boot-time check that refuses to serve an app whose on-disk manifest doesn't match its `data.db`'s actual shape, instead of silently materializing partial idempotent DDL against it.
3. Add minimal panic-recovery middleware around every HTTP handler.
4. Unify `api/coerce.go`, `sandbox/data.go`'s `coerceValue`, and `validate/semantic.go`'s `validateDefault` into one shared validate-and-coerce function, then extract `api/api.go`'s handler bodies into a transport-agnostic domain layer built on it.
5. Wire one real caller to `sandbox.Invoke` (even a minimal internal HTTP or CLI entry point) to convert the sandbox from tested-in-isolation to load-bearing — or explicitly defer it and say so in the README.
