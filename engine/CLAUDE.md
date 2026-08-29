# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pocketknife is a monorepo. `engine/` is a single, generic, schema-driven HTTP backend written in Go: one server turns a declarative **manifest** (`catalog/<app_id>/manifest.json`) into a working API + SQLite database — no per-app code generation, no per-app process. `README.md` is the authoritative spec for the v1 runtime (manifest format, type set, HTTP API, query syntax, error envelope); read it for those details rather than re-deriving them.

`catalog/` holds the apps the engine serves: each `catalog/<app_id>/` has a `manifest.json` (source of truth), an optional `data/` folder of starter-row seed files, and an optional `skills/` folder of agent skills (`SKILL.md` per skill) for that app's own MCP tools. `data/<app_id>/data.db` is where the app's runtime SQLite database lives — kept separate from `catalog/` so the catalog stays purely declarative and safe to check into version control. `hyrox` is currently the only catalog app.

`apps/` (`apps/web`, `apps/runtime`) are placeholders: the previous per-app frontend serving, the platform admin SPA (`shell/`), the build/activation engine (`build/`, `platform/`), the agent→backend deploy wire (`deployapi/`), and the Node/TypeScript authoring agent (`agent/`) were all removed as part of a monorepo re-architecture. Both the frontend and the agent runtime are being rebuilt from scratch under `apps/`; treat any mention of them elsewhere in this repo's history/docs as describing the *old* architecture unless you're specifically asked to resurrect it.

## Commands

```sh
make test                 # full suite: cd engine && go test ./...
make build                # build bin/pocketknife
make run                  # serve catalog/ on :8080
make vet                  # go vet ./...
make fmt                  # go fmt ./...
make clean                # rm bin/, delete data/**/data.db*

cd engine && go test ./migrate/...                       # one package
cd engine && go test ./migrate/ -run TestApply           # one test (regex on name)
cd engine && go test ./... -run TestX -v                 # verbose single test across packages
```

Go must be on PATH. If absent (Homebrew is unavailable on this machine — see global guidance), install the official tarball into a user dir: `curl -fsSL https://go.dev/dl/go1.26.4.darwin-arm64.tar.gz | tar -C ~/.local -xz` then `export PATH="$HOME/.local/go/bin:$PATH"`.

`engine/go.mod` is the module root — Go commands must run with `engine/` as the working directory (the Makefile already `cd`s there); running `go build`/`go test` from the repo root will not find the module.

### The binary's two modes (`engine/cmd/pocketknife/main.go`)

```sh
./bin/pocketknife -catalog catalog [-data data] [-addr 127.0.0.1:8080] [-cors]   # serve (default, no subcommand); -addr defaults to localhost-only
./bin/pocketknife migrate -catalog catalog [-data data] -app <id> -to <new.json> [-confirm] [-witnesses w.json]  # evolve schema, no data loss
```

## Architecture

The non-negotiable invariants (stable IDs as the spine, one SQLite file per app, manifests-on-disk as source of truth, validation as a hard gate, automatic platform columns, parameterized SQL, closed type set, determinism) are documented in `README.md` under "Contract / invariants" — **treat them as binding constraints on any change.**

### Request/boot path (the v1 core)

`schema/` (manifest types + parser → schema model) → `validate/` (JSON-Schema structural + semantic checks; the hard gate) → `materialize/` (schema → idempotent SQLite DDL) → `store/` (per-app connections, parameterized queries, stable-id-keyed columns; `Store.VerifySchema` is the boot-time guard against a manifest and its `data.db` having silently diverged) → `registry/` (in-memory app registry; `registry.Load(catalogDir, dataDir)` rebuilds it from disk on every boot — scanning `catalogDir` for manifests, opening each app's `data.db` under `dataDir/<app_id>/`, creating that directory if needed — calling `VerifySchema` after materializing and skipping — never serving — a mismatched app). The manifest's canonical JSON Schema is `manifest.schema.json`, embedded into the binary via `schema_embed.go`.

`domain/` is the transport-neutral runtime-operations layer every CRUD surface reduces to: `Create/Get/List/Update/Delete` resolve the app/entity through the registry, enforce the entity's declared operations, run the shared field-coercion rules (`domain.CoerceFieldValue` — the one place text/integer/real/boolean/datetime/enum/reference validation lives; `api/` and `sandbox/` both call it rather than each reimplementing it), and call the store, returning a structured `*domain.OpError` any transport maps to its own wire shape. Each op also has a `*In` variant (`CreateIn`/`GetIn`/`UpdateIn`/`DeleteIn`) that takes an explicit `RowStore` instead of resolving `ra.Store` itself — the seam `tools/` uses to run several of these atomically against one `store.Tx`. `api/` is a thin `net/http` adapter over `domain` (one generic CRUD/list handler set, query-string parsing, HTTP status/error-code mapping); `mcpserver/` is the analogous adapter for MCP, via `tools/`.

### Migration engine (`migrate/`)

Evolves one app from its on-disk manifest to a new version without data loss. Pipeline: `Diff` (pure structural diff, matched **entirely by stable id** — same id + new name = rename moving no data) → `Classify` (labels each op `ClassSafe` or `ClassDestructive` purely from structure; never trusts a caller hint; ambiguous → destructive) → require explicit `-confirm` + `Witness`es for destructive ops → `snapshot` → `Execute` (one transaction via `store.RunMigration`). A **`Witness`** is the closed, declarative vocabulary (coerce / backfill / remap) a destructive op must supply — there is no arbitrary-code hook. On any execution failure: restore the snapshot, keep the prior registration. This is the *only* mechanism for landing a schema change — there is no separate build/deploy orchestration layer anymore.

### Sandboxed functions (`sandbox/`, `broker/`, `consent/`)

`sandbox/` is the **real** security boundary (the manifest only *declares* capabilities). Function bodies run as adversarial WebAssembly under wazero with no filesystem, no env, no raw network — the only way out is a fixed, capability-checked host ABI (the `pocketknife` host module in `host.go`). Resource limits (memory pages, wall-clock timeout, input/output byte caps) are enforced per invocation. The three gated host calls (`data_call`, `network_fetch`, `model_call`) return sentinel codes; a `codeDenied` carries no payload so a function can't use responses as an oracle. `broker/` is the **only** path to a model provider — the provider token is read once from env, held unexported, and never reaches a function or the browser. `consent/` derives the union of capabilities an app's functions request (pure function of the manifest), for a future frontend to render. Not yet wired into any HTTP or MCP entry point — see `docs/phase-4-wiring.md`.

### MCP tools (`tools/`, `mcpserver/`)

A manifest's optional `tools` section declares named operations: an ordered, non-branching sequence of CRUD steps against the app's own entities, with each `rowId`/`set` value either a literal or a `"$params.<name>"` / `"$steps.<id>.<field>"` reference resolved at call time (forward references rejected by `validate/semantic.go`). `tools.Execute` runs one tool's steps in order inside a single `store.Tx` — a failure at any step rolls back everything earlier steps in that call did — calling `domain`'s `*In` functions per step. Because a tool can only ever call CRUD the entity's own `operations` already allow, it needs no sandbox (unlike `functions`, which run arbitrary code and do). `mcpserver.NewServer` exposes each app's tools as an MCP server at `/mcp/{app_id}` (streamable HTTP, stateless, via `github.com/modelcontextprotocol/go-sdk`), built fresh from the registry per session — a tool's `params` render straight to the MCP call's JSON Schema, and a tool-level failure comes back as `CallToolResult.IsError`, not a protocol error. `catalog/<app_id>/skills/` is where an agent-facing skill documenting *when and how* to call a given app's tools lives — see `catalog/hyrox/skills/log-workout-result/SKILL.md`.

## Workflow conventions

- This repo uses **OpenSpec** (`openspec/`, `schema: spec-driven`). Changes are proposed as specs under `openspec/changes/<date>-<name>/` (proposal, design, tasks, per-capability specs) and moved to `openspec/changes/archive/` when complete; long-lived capability specs live in `openspec/specs/`. The `openspec-*` / `opsx:*` skills drive this flow.
- Each Go package leads with a substantial doc comment stating its responsibility and security posture — read it before editing; match that altitude when adding code.
- `test_project_hub.sh` is an end-to-end shell exercise against a running server (targets an example `project_hub` manifest, not one of the apps currently in `catalog/`).
