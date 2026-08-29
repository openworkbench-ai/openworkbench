# Pocketknife

A single, generic, schema-driven HTTP backend. One server turns a declarative
**manifest** into a working API and database — for any app — with **no per-app
code generation and no per-app process**.

A manifest does not compile to a program. It registers a schema with one generic
server that already knows how to serve any schema. "Creating a backend from a
manifest" means exactly three things: **validate** the manifest, **materialize**
that app's database tables, and **register** its schema in an in-memory registry.
One set of CRUD/query handlers then serves every app; a handler looks an app up
by id and serves it from its registered schema.

Beyond that core, the same binary also: **evolves** an app's schema to a new
manifest version without losing data (the migration engine), and contains a
capability-checked WebAssembly **sandbox** for declared server-side functions —
implemented and tested, but not yet invoked by any HTTP or MCP entry point in
this binary; see "Sandboxed functions" below for what that means in practice
today.

An app can also declare **tools**: named, manifest-defined operations that
run one or more of its own CRUD calls in sequence, exposed live over MCP at
`/mcp/{app_id}` — one MCP tool per declared tool, one call to the tools engine
(`tools/`) per invocation, atomic across every step. See "Optional: `tools`"
and "MCP tools" below.

This is a monorepo. `engine/` is the Go backend described above; `catalog/`
holds the declarative apps it serves (manifest + optional seed data + agent
skills, per app); `data/` holds the runtime `data.db` each app gets; `apps/`
is where the frontend and agent runtime that used to live here (per-app UI
serving, the shell admin SPA, the Claude-backed authoring agent) are being
rebuilt from scratch — see [Layout](#layout).

## Contract / invariants

- **One generic server, no per-app code.** No codegen, no per-app processes.
- **Stable IDs are the spine.** Every app, entity and field has an immutable
  `id` separate from its `name`. The `id` never changes; the `name` may. Storage
  is keyed to a field's identity (its id), never its name.
- **One SQLite file per app** (`data/<app_id>/data.db`). Never shared across
  apps — physical isolation.
- **Manifests on disk are the source of truth; the registry is a derived cache**
  rebuilt from disk on every boot. Deleting the registry loses nothing.
- **Validation is a hard gate.** A manifest that fails validation is never
  materialized and never served. Validation returns a structured list of errors
  (`path` + `code` + `message`).
- **Platform columns are automatic and never declared.** Every table gets
  `id` (TEXT PRIMARY KEY), `created_at`, `updated_at` (ISO-8601 UTC strings). A
  manifest declaring any of these reserved names is rejected.
- **All SQL values are parameterized.** Identifiers come only from validated,
  SQL-safe names. The only literals in generated DDL are enum `CHECK` values,
  which are schema constants (single-quote-escaped), never request data.
- **Closed type set** (below). Anything else is a validation error.
- **Determinism.** The same manifest always yields the same schema;
  materialization is idempotent (`CREATE TABLE IF NOT EXISTS`).

## Layout

```
engine/                the Go backend — everything below is engine/<pkg>
  cmd/pocketknife       entrypoint (serve / migrate modes)
  schema/               manifest types + parser → schema model
  validate/             JSON-Schema structural + semantic checks (the hard gate)
  materialize/          schema → SQLite DDL
  store/                per-app SQLite connections, parameterized queries
  domain/               transport-neutral runtime operations (create/get/list/update/delete), shared field coercion
  api/                  thin net/http adapter over domain/: routing, query-string parsing, HTTP status mapping
  registry/             in-memory app registry, boot loader
  seed/                 starter data loader (catalog/<id>/data/), first-boot only
  migrate/              schema diff → classify → witness → snapshot → execute
  sandbox/              capability-checked WebAssembly sandbox for functions
  broker/               the only path from a function to a model provider
  consent/              derives an app's union capability surface from the manifest
  tools/                executes a manifest-declared tool's CRUD step sequence atomically
  mcpserver/            MCP transport over tools/: one /mcp/{app} endpoint per app
  validateapi/          POST /validate — validates a manifest without registering it
  cors/                 optional dev-only cross-origin middleware
  manifest.schema.json  canonical JSON Schema for the manifest format
  schema_embed.go       embeds manifest.schema.json into the binary
  go.mod, go.sum

catalog/                declarative apps served by the engine
  <app_id>/
    manifest.json        the app's manifest (source of truth)
    data/                 optional starter-row seed files, one per entity
    skills/               optional agent skills for this app (SKILL.md per skill)

data/                   runtime state, never checked in
  <app_id>/data.db       the app's SQLite database (created on first boot)

apps/                   frontend + agent runtime — being rebuilt from scratch
  web/                   placeholder for the new frontend
  runtime/               placeholder for the new agent runtime

bin/                    build output (bin/pocketknife)
```

The previous per-app frontend serving (`assets/`, `client/`), the platform
admin SPA (`shell/`), the build/activation engine (`build/`, `platform/`,
`platform.db`), the agent→backend deploy wire (`deployapi/`), and the Node
agent (`agent/`) have all been removed. `apps/web` and `apps/runtime` are
where their replacements will be built.

## Running

Go is required. If it is not on your PATH (and Homebrew is unavailable), install
the official tarball into a user directory, e.g.:

```sh
curl -fsSL https://go.dev/dl/go1.26.4.darwin-arm64.tar.gz | tar -C ~/.local -xz
export PATH="$HOME/.local/go/bin:$PATH"
```

Then, from the repo root:

```sh
make test                 # run the full test suite (cd engine && go test ./...)
make build                # build bin/pocketknife
make run                   # serve catalog/ on 127.0.0.1:8080
make vet / make fmt        # go vet / go fmt
```

The binary has two modes. With no subcommand it **serves**; `migrate` is a
headless one-shot command.

```sh
# serve (default): the schema-driven API + MCP tools over one origin
./bin/pocketknife -catalog catalog [-data data] [-addr 127.0.0.1:8080] [-cors]

# migrate: evolve one app's schema to a new manifest version, no data loss
./bin/pocketknife migrate -catalog catalog [-data data] -app <id> -to <new_manifest.json> [-confirm] [-witnesses <file.json>]
```

On boot the server scans `<catalog>/*/manifest.json`, validates each (skipping
and logging any that fail), materializes each app's `data/<app_id>/data.db`,
verifies the resulting database actually matches the manifest (skipping, not
silently serving, an app whose `data.db` predates a manifest change that was
never migrated), registers the schema, and serves. A restart re-derives the
registry from disk and preserves all data.

**Trust model.** `-addr` defaults to `127.0.0.1:8080` — the Workbench v0.1
runtime assumes a trusted local machine. Exposing the runtime to a network
(e.g. `-addr :8080` to bind every interface) is an explicit configuration
decision the operator has to make; stronger authentication for that case is
out of scope for v0.1.

`-cors` enables permissive cross-origin headers for running a separate
frontend dev server; the production binary serves the API from one origin
and never needs it.

## Manifest format

Canonical format is JSON, one immutable document per app version, at
`catalog/<app_id>/manifest.json`. The written contract is
[`engine/manifest.schema.json`](engine/manifest.schema.json), used as the
structural validation layer.

```json
{
  "app": { "id": "reading_tracker", "name": "Reading Tracker", "emoji": "📚", "color": "#8E86CF", "version": 1 },
  "entities": [
    {
      "id": "ent_book",
      "name": "book",
      "operations": ["create", "read", "update", "delete"],
      "fields": [
        { "id": "fld_title",  "name": "title",  "type": "text",    "required": true, "max": 200 },
        { "id": "fld_author", "name": "author", "type": "text" },
        { "id": "fld_rating", "name": "rating", "type": "integer", "min": 1, "max": 5 },
        { "id": "fld_done",   "name": "done",   "type": "boolean", "default": false }
      ]
    }
  ]
}
```

Rules:

- `app.id`, `entity.id`, `field.id` are immutable stable IDs, unique within their
  scope, non-empty. Convention `ent_*` / `fld_*` (convention, not enforced).
- `name` (entities, fields) is the SQL identifier **and** JSON key. It must match
  `^[a-z][a-z0-9_]*$`, be unique among siblings, and must not be a reserved
  platform name (`id`, `created_at`, `updated_at`). `app.name` / `app.emoji` /
  `app.color` are free-form display values, currently unused by anything in
  the engine — they're metadata for whatever frontend eventually lands in
  `apps/web`.
- `operations` is optional per entity (default: all four). Subsetting it
  restricts the API surface; a disabled operation returns **405**.
- Unknown top-level keys, unknown field keys, constraint keys not allowed for a
  field's type, a default that violates the field's own constraints, an enum
  default not in `values`, and a reference whose `target` does not resolve are
  all rejected.

### Type set (v1, closed) and SQLite mapping

| type        | meaning                | allowed constraint keys                          | SQLite column | notes |
|-------------|------------------------|--------------------------------------------------|---------------|-------|
| `text`      | UTF-8 string           | `required`, `unique`, `default`, `min`/`max` (length) | `TEXT`    | length `CHECK`s |
| `integer`   | 64-bit int             | `required`, `unique`, `default`, `min`/`max` (value)  | `INTEGER` | range `CHECK`s |
| `real`      | float                  | `required`, `unique`, `default`, `min`/`max` (value)  | `REAL`    | range `CHECK`s |
| `boolean`   | true/false             | `required`, `default`                            | `INTEGER`     | stored 0/1; JSON `true`/`false` at the boundary |
| `datetime`  | ISO-8601 UTC instant   | `required`, `default`                            | `TEXT`        | one canonical encoding |
| `enum`      | one of a fixed set     | `required`, `default`, `values` (required, non-empty) | `TEXT`   | `CHECK (col IN (...))` |
| `reference` | points at another row  | `required`, `target` (required), `onDelete`      | `TEXT`        | `FOREIGN KEY (col) REFERENCES <target>(id) ON DELETE <action>` |

`onDelete` is `set_null` (default), `restrict`, or `cascade`. `required` →
`NOT NULL`; `unique` → a `UNIQUE` index. Every table additionally gets
`id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL`, and
`PRAGMA foreign_keys = ON` is enabled per connection.

Datetimes are stored and emitted in one canonical encoding: ISO-8601 UTC with
millisecond precision and a literal `Z` (e.g. `2026-06-21T15:21:58.940Z`).

### Optional: `frontend` and `functions`

Two optional top-level keys extend an app's manifest beyond a bare API.
**Neither is currently served by anything in the engine** — `frontend` is
structurally validated and parsed but has no consumer since the frontend
serving packages were removed pending a redesign (see [Layout](#layout));
`functions` is fully implemented in `sandbox/` but not yet wired to any HTTP
or MCP entry point (see "Sandboxed functions" below). Both are documented
here because the manifest format still declares and validates them.

```json
{
  "app": { "id": "tasks", "name": "Tasks", "emoji": "✅", "version": 1 },
  "entities": [ ... ],
  "frontend": { "dist": "frontend/dist", "entry": "index.html" },
  "functions": [
    {
      "id": "fn_summarize",
      "name": "summarize",
      "entry": "functions/summarize.wasm",
      "capabilities": {
        "data":    [ { "entity": "ent_task", "operations": ["read"] } ],
        "network": ["api.example.com"],
        "model":   true
      }
    }
  ]
}
```

- **`frontend`** names a built static bundle. `dist` (required) is the asset
  directory; `entry` (optional, default `index.html`) is the file that would
  be served for the root and for any path that doesn't match a real asset.
- **`functions`** declares sandboxed server-side functions. `entry` must name an
  already-built `.wasm` module. `capabilities` is the **closed** set of host
  power the sandbox grants — and the manifest only ever *declares* it; the
  sandbox is what enforces it:
  - `data` — per-entity operation grants (referenced by the entity's stable id),
    each restricted to a subset of that entity's enabled operations.
  - `network` — an **exact-match** hostname allow-list. No wildcards, no general
    fetch.
  - `model` — access to the model broker. The function never receives the
    underlying provider token.

### Optional: `tools`

A third optional top-level key, `tools`, declares named operations exposed to
MCP clients at `/mcp/{app_id}` (see "MCP tools" below). Unlike `functions`,
a tool is not code: it's an ordered, non-branching sequence of CRUD calls
into the app's *own* entities, so it needs no sandbox — it can't do anything
a direct call against `/apps/{app}/{entity}` couldn't already do; it only
names and sequences those calls, atomically, in one transaction.

```json
{
  "app": { "id": "tasks", "name": "Tasks", "version": 1 },
  "entities": [ ... ],
  "tools": [
    {
      "id": "tool_new_project_task",
      "name": "new_project_task",
      "description": "Create a project, then a task inside it",
      "params": [
        { "id": "p_project_name", "name": "project_name", "type": "text", "required": true },
        { "id": "p_title", "name": "title", "type": "text", "required": true }
      ],
      "steps": [
        { "id": "project", "op": "create", "entity": "ent_project", "set": { "name": "$params.project_name" } },
        { "id": "task", "op": "create", "entity": "ent_task", "set": { "title": "$params.title", "project": "$steps.project.id" } }
      ]
    }
  ]
}
```

- **`params`** declares the tool's call-time inputs using the exact same
  shape as an entity field (`type`, `required`, `default`, and that type's
  constraint keys) — so the same field-coercion rules validate them, and the
  MCP endpoint renders them as a real JSON Schema for the tool's arguments.
- **`steps`** is the ordered CRUD sequence, one of `create`/`read`/`update`/
  `delete`/`list` per step against one entity, restricted to operations that
  entity's own `operations` list already allows (`list` is gated by that same
  entity's `read` permission — it has no separate entity-level grant of its
  own). `rowId` is required for read/update/delete and forbidden for
  create/list; `set` maps field name to value for create/update. `list`
  takes no filter/sort/pagination params — it returns every row (as
  `{"rows": [...], "total": N}`, capped the same way an unfiltered `GET
  /apps/{app}/{entity}` call is).
- Every `rowId`/`set` value is either a **literal** JSON value or a
  **reference**: a string of the form `"$params.<name>"` (this call's
  arguments) or `"$steps.<id>.<field>"` (an earlier step's result row in the
  same call — forward references and cycles are rejected at validation time,
  since a step can only ever reference something that ran before it).
- All steps in one call run inside **one database transaction**: a failure
  at any step rolls back every earlier step in that same call, so a tool
  either fully applies or has no effect at all.

An app can also ship agent skills for its own tools — see
`catalog/hyrox/skills/log-workout-result/SKILL.md` for an example that tells
an agent when and how to call hyrox's `log_exercise_result` MCP tool.

## HTTP API

All routes are namespaced by app: `/apps/{app_id}/{entity_name}`.

| Method & path                         | Action | Success |
|---------------------------------------|--------|---------|
| `POST   /apps/{app}/{entity}`         | create (body: JSON object of field→value) | `201` created row |
| `GET    /apps/{app}/{entity}`         | list (query syntax below) | `200` `{data, total, limit, offset}` |
| `GET    /apps/{app}/{entity}/{id}`    | read one | `200` / `404` |
| `PATCH  /apps/{app}/{entity}/{id}`    | partial update (only supplied fields change; `updated_at` bumped) | `200` |
| `DELETE /apps/{app}/{entity}/{id}`    | delete | `204` |

### List query syntax (v1, AND-combined, no OR/nesting/joins)

- `filter=<field>:<op>:<value>` — repeatable, AND-ed. Ops: `eq`, `ne`, `gt`,
  `gte`, `lt`, `lte`, `like`.
- `sort=<field>` (ascending) or `sort=-<field>` (descending). Repeatable.
  `id`, `created_at`, `updated_at` are sortable/filterable too.
- `limit=<n>` (default 50, capped at 200), `offset=<n>` (default 0).
- `total` is the count of all rows matching the filters, ignoring limit/offset.

### Error envelope

```json
{ "error": { "code": "...", "message": "...", "details": [ ... ] } }
```

| Status | When |
|--------|------|
| `400`  | malformed request / body fails field validation (details list per-field issues) |
| `404`  | unknown app, entity, or row |
| `405`  | operation disabled for the entity |
| `409`  | unique constraint violation, or a reference constraint (e.g. `onDelete: restrict`) |
| `500`  | unexpected internal error |

Body validation reuses the manifest's field rules: `required`, `min`/`max`,
enum membership, and reference-target existence.

### Other routes

| Method & path | Action |
|---------------|--------|
| `POST /validate` | Validate a candidate manifest without registering it. `200 {"valid":true}` or `422 {"valid":false,"errors":[...]}` |
| `* /mcp/{app}` | MCP streamable-HTTP endpoint exposing the app's declared `tools` (see "MCP tools" below); `404` for an unknown app id |

## curl examples

### hyrox (references, enum, cascade deletes, tools)

```sh
# create a plan, then a workout inside it
PLAN_ID=$(curl -s -X POST localhost:8080/apps/hyrox/plan -d '{"name":"Base block"}' | jq -r .id)
WORKOUT_ID=$(curl -s -X POST localhost:8080/apps/hyrox/workout -d "{\"plan\":\"$PLAN_ID\",\"name\":\"Week 1\"}" | jq -r .id)

# add an exercise (station is an enum); target_seconds is optional
curl -s -X POST localhost:8080/apps/hyrox/exercise \
  -d "{\"workout\":\"$WORKOUT_ID\",\"order\":1,\"station\":\"sled_push\",\"target_seconds\":300}"

# list, filter, sort
curl -s "localhost:8080/apps/hyrox/exercise?filter=status:eq:planned&sort=order"

# deleting a plan cascades to its workouts and exercises (onDelete: cascade)
curl -s -X DELETE localhost:8080/apps/hyrox/plan/$PLAN_ID
```

### Manifest-declared tools, over MCP

```sh
# hyrox declares tools like log_exercise_result — see catalog/hyrox/manifest.json
# and catalog/hyrox/skills/log-workout-result/SKILL.md for how an agent should
# call it. The tool set is live at:
curl -s -X POST localhost:8080/mcp/hyrox -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Schema migrations (`engine/migrate/`)

Evolves one app from its on-disk manifest to a new version **without losing
data**. `pocketknife migrate -app <id> -to <new.json>` runs the pipeline:

1. **validate** the new manifest (the same hard gate).
2. **diff** old vs. new — a pure structural diff matched **entirely by stable
   id**. A field whose id is unchanged but whose name differs is a *rename* and
   moves no data; a new id is an *add*, a missing id is a *drop*.
3. **classify** each operation as `safe` (information-preserving, auto-applied)
   or `destructive` (information-losing). Classification reads only the
   operation's structure — never a caller hint — and treats anything ambiguous
   as destructive.
4. destructive operations require an explicit **`-confirm`** *and* a
   **witness** for each one (no default, no silent coercion). The witness
   vocabulary is closed:
   - `coerce` — a type narrowing (e.g. `real`→`integer`): `truncate`, `round`,
     or `fail` the migration on any lossy value.
   - `backfill` — a nullable→not-null tightening: the value written into
     currently-null rows.
   - `remap` — an enum value removed: how to rewrite rows still holding it.
5. **snapshot** the database, then **execute** the whole changeset in one
   transaction. Renames touch no SQL (the physical column is the field's stable
   id); adds/drops use native `ADD`/`DROP COLUMN`; type/nullability/enum/
   reference changes use the SQLite table-rebuild pattern. On any failure the
   snapshot is restored and the prior registration kept.

Witnesses are supplied via `-witnesses <file.json>`, a JSON object keyed by the
stable **field id** the witness applies to.

## Seed data (`engine/seed/`)

An app under `catalog/<app_id>/` may ship an optional `catalog/<app_id>/data/`
folder of starter rows. It has no effect on an app whose `data.db` already
exists — it only runs on the one boot where `registry.Load` finds no
`data.db` file yet under `data/<app_id>/`, i.e. an app's very first boot.
Deleting `data/<app_id>/data.db*` (already the `make clean` reset mechanism)
is how you re-trigger it in dev.

- One file per entity, named `<entity_name>.json` (the entity's `name`, not
  its stable id).
- Each file is a JSON array of row objects, shaped exactly like a `POST
  /apps/{app}/{entity}` body.
- An optional `"$key"` string per row labels that row for other rows —
  possibly in a later file — to reference; it is stripped before insertion
  and never stored.
- A `reference`-typed field's value must be a `"$<entity_name>.<key>"`
  placeholder naming another row's `"$key"`, resolved to its real generated
  id. There is no literal-id fallback — the database is fresh, so there is
  nothing else yet to reference.
- Entities seed in the manifest's declared order (the same order `materialize`
  emits `CREATE TABLE` in), so an entity referenced by another must be
  declared — and therefore seeded — first. No reference cycles or
  self-references are supported.
- All rows across all files insert in one transaction: any error (an unknown
  seed filename, a row that fails the entity's normal Create validation, an
  unresolved reference) rolls every one of them back, and the app is skipped
  for that boot — logged, never served — the same hard-gate posture
  `registry.Load` already applies to an invalid manifest.

## Sandboxed functions (`engine/sandbox/`, `engine/broker/`, `engine/consent/`)

**Status: implemented and tested in isolation; not yet wired into any live
entry point.** Everything below describes what the sandbox *enforces once a
function is invoked* — but nothing in this binary currently invokes one: no
HTTP route triggers `sandbox.Invoke`, `broker.New`/`NewHTTPCaller` is never
constructed from the environment, and no app under `catalog/` declares a
`functions` block. A future MCP transport (or a dedicated HTTP endpoint) is
the natural place to wire this in; until then, treat this section as a
description of a well-tested library, not of a running feature. See
`docs/phase-4-wiring.md` for the tracked wiring gaps.

A function's manifest entry only *declares* capabilities; `sandbox/` is the real
boundary that *enforces* them. Each function body is treated as adversarial: it
runs as a WebAssembly module under wazero with **no filesystem, no environment,
no raw network**, behind a fixed, capability-checked host ABI (the `pocketknife`
host module) that is the only way out. Per-invocation resource limits apply
(linear memory, a wall-clock timeout, input/output byte caps). The three gated
host calls (`data_call`, `network_fetch`, `model_call`) return sentinel codes; a
denial carries no payload, so a function can't use responses as an oracle for
capabilities it wasn't granted.

`broker/` is the **only** path from a function to a model provider: the provider
token is read once from the environment, held unexported, and never reaches a
function or the browser. `consent/` derives the union of every function's
declared capabilities for an app — a pure function of the manifest — so a
future frontend can show the full capability surface before the app is
allowed to run.

## MCP tools (`engine/mcpserver/`, `engine/tools/`)

Every app's declared `tools` (see "Optional: `tools`" above) are live over
MCP at `/mcp/{app_id}` — a [streamable-HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
endpoint, one per app, served stateless (no session persistence needed since
a tool call is a single request/response, same as the rest of this API). An
unknown app id is a `404`, matching every other per-app route.

`tools.Execute` is the transport-neutral engine: given an app, a tool (by id
or name) and a JSON object of params, it validates the params against the
tool's declared parameter list (reusing `domain.CoerceFieldValue` exactly, so
a reference-typed param's target is existence-checked the same way a normal
write's would be), then runs every step in order against **one database
transaction** — `store.Tx`, a transaction-scoped view of the same
Insert/GetByID/Update/Delete/List/Exists surface `store.Store` exposes — so a
failure at any step rolls back everything earlier steps in that call did.
Each step calls `domain.CreateIn`/`GetIn`/`UpdateIn`/`DeleteIn`, the same
validation and coercion logic `domain.Create`/`Get`/`Update`/`Delete` run for
the HTTP API, just against that shared transaction instead of the store's
ambient connection.

`mcpserver.NewServer` is the thin transport adapter: for each app it builds
an `mcp.Server` (from the [official Go MCP SDK](https://github.com/modelcontextprotocol/go-sdk))
with one MCP tool per declared tool — the tool's `params` rendered as a JSON
Schema for the call arguments — and a handler that decodes the call's raw
arguments and runs `tools.Execute`. A tool-level failure (bad params, a
step's validation error, a row not found) comes back as
`CallToolResult.IsError`, not a protocol-level error, so an MCP client sees
it as something to explain or retry rather than a transport fault. The
server is resolved fresh from the registry per session, so a redeployed
app's tool set is visible immediately.

## Deferred (still out of scope)

Intentionally **not** built, or removed pending a redesign:

- **Frontend serving, and a frontend to serve.** `assets/`, `client/`, and
  `shell/` were removed; `apps/web` is a placeholder for their replacement.
- **An authoring/deploy agent.** `agent/` and the ingest wire it used
  (`deployapi/`, `POST /deploy`) were removed; `apps/runtime` is a placeholder
  for its replacement.
- **Build/activation orchestration.** `build/` and `platform/` (job tracking,
  frontend build+activate, the admin API) were removed along with the
  frontend they existed to serve. New apps register via `registry.Load`'s
  automatic scan of `catalog/`; schema evolution goes through `migrate` only.
- **On-box compilation.** A future frontend build step, if any, would
  reference pre-built output the same way `functions` already does for
  `.wasm` — pocketknife itself never bundles or compiles anything.
- **Multi-user auth, roles, permissions.** There is no session layer and no
  per-app row-level access control.
- **Real-time / subscriptions.**
- **Query features beyond the v1 surface** — no OR, nesting, joins, or extra
  operators/types.
