# Implementation status — what's built and how

*A snapshot of the current monorepo after the re-architecture that removed the
old `agent/`, `shell/`, `build/`, `platform/`, `deployapi/` layers (see
[`engine/README.md`](../engine/README.md) → "Deferred"). Everything below
describes what actually runs today. The other files in this `docs/` folder
(`engine-assessment.md`, `stabilization-report.md`, `stabilization-followup-report.md`,
`phase-4-wiring.md`, `bridge-protocol.md`, `pocketknife-design-context.md`) and
most of `openspec/changes/*` and `openspec/specs/*` describe that **prior**
architecture — a build/activation pipeline, a `shell/` admin SPA, a Claude-backed
authoring agent talking to it over `POST /deploy` — which has since been deleted.
Treat those as historical design record, not current state.*

## The shape of the system

Three independently runnable pieces, two languages, three processes:

```
apps/web       React/Vite SPA — chat UI + an app inspector          (dev: :5173, proxies /api)
apps/runtime   Node/TS agent runtime + a tiny HTTP/SSE API server   (:8787)
engine/        Go — "pocketknife", a schema-driven CRUD engine      (:8080)
```

`apps/runtime`'s server is the only thing the browser talks to. It in turn talks
to the Go engine two ways: as a **proxy** (forwarding raw CRUD reads for the data
inspector) and as an **MCP client** (the agent calls each catalog app's tools
over `/mcp/{app_id}`). Nothing in the browser or the agent runtime writes SQL or
touches `data/` directly — every write goes through the engine.

```
Browser (apps/web)
   │  fetch("/api/...")  — Vite dev proxy → :8787
   ▼
apps/runtime/server.ts (:8787)
   ├─ GET  /api/apps                     → app-loader.ts (apps/*/app.json + catalog/*/manifest.json)
   ├─ GET  /api/apps/:id/{tools,skills,entities}
   ├─ GET  /api/apps/:id/data/:entity    → proxies to engine :8080  GET /apps/{id}/{entity}
   ├─ GET  /api/models, POST /api/model  → pi/models.json + pi-coding-agent's ModelRuntime
   └─ POST /api/chat (SSE)               → backends/pi.ts (Pi SDK agent session)
                                               └─ tool "mcp" → engine :8080  POST /mcp/{app_id}  (MCP over Streamable HTTP)
engine/cmd/pocketknife (:8080)
   └─ serves catalog/hyrox from its manifest: CRUD API + /mcp/hyrox
```

## 1. `engine/` — Pocketknife, the schema-driven backend (Go)

A single generic HTTP server that turns a declarative JSON **manifest**
(`catalog/<app_id>/manifest.json`) into a working REST API and an isolated
SQLite database, with **no per-app code and no per-app process**. This is the
most mature and most heavily tested part of the repo: ~13,500 lines across
`engine/`, roughly half of it tests, spread over 30 `_test.go` files; `go
build ./...`, `go vet ./...`, and `go test ./...` are all clean today — 188
passing tests across all 17 packages.

**Request/boot pipeline**, each stage its own package:
`schema/` (parses manifest JSON into a typed model) → `validate/` (JSON-Schema
structural + semantic checks — the hard gate; nothing invalid is ever
materialized or served) → `materialize/` (schema → idempotent SQLite DDL,
`CREATE TABLE IF NOT EXISTS`) → `store/` (one SQLite connection per app,
fully parameterized queries, `VerifySchema` as a boot-time guard against a
`data.db` that has silently drifted from its manifest) → `registry/`
(`registry.Load` rescans `catalog/` on every boot and rebuilds the in-memory
registry from disk — deleting the registry loses nothing) → `domain/`
(transport-neutral `Create/Get/List/Update/Delete`, the one place field
coercion/validation lives — `api/`, `tools/`, and `sandbox/` all call into it
rather than reimplementing validation) → `api/` (thin `net/http` adapter:
routing, query-string parsing, HTTP status/error mapping).

**Manifest format** (`engine/manifest.schema.json`, embedded into the binary):
an app declares `entities`, each with `fields`. Every app/entity/field carries
an immutable stable `id` (storage is keyed to the id, never the display
`name` — a rename moves no data). Seven closed field types map onto SQLite:
`text`, `integer`, `real`, `boolean`, `datetime`, `enum`, `reference`
(foreign key with `onDelete: set_null|restrict|cascade`). Every table
automatically gets `id`, `created_at`, `updated_at`; those names are reserved
and rejected if a manifest tries to declare them.

**HTTP API**, namespaced by app — `/apps/{app_id}/{entity}`:
`POST` create, `GET` list (`filter=field:op:value` AND-combined, `sort`,
`limit`/`offset` capped at 200), `GET /{id}` read, `PATCH /{id}` partial
update, `DELETE /{id}`. Errors come back as
`{"error": {"code","message","details"}}` with standard status codes
(400/404/405/409/500). `POST /validate` validates a candidate manifest
without registering it.

**Optional manifest key `tools`** (`engine/tools/`, `engine/mcpserver/`):
an app can declare named, multi-step operations — an ordered, non-branching
sequence of CRUD calls against its *own* entities, with `$params.<name>` and
`$steps.<id>.<field>` references resolved at call time. `tools.Execute` runs
every step of one call inside a single `store.Tx`, so a tool either fully
applies or has no effect. Every app's tools are exposed live over MCP
(streamable-HTTP, via the official Go MCP SDK) at `/mcp/{app_id}` — one MCP
tool per declared tool, params rendered as that tool's JSON Schema, a
tool-level failure surfacing as `CallToolResult.IsError` rather than a
transport error. This is how the agent runtime calls into catalog apps (see
§3) — it needs no sandbox, since a tool can only ever do what the entity's
own `operations` already permit.

**Migrations** (`engine/migrate/`): evolves one app from its on-disk manifest
to a new version without losing data — `Diff` (pure structural diff matched
entirely by stable id) → `Classify` (`safe`/`destructive`, purely from
structure, never a caller hint) → destructive ops require an explicit
`-confirm` and a **witness** per op (`coerce`/`backfill`/`remap` — closed
vocabulary, no arbitrary code) → `snapshot` the database → `Execute` the
whole changeset in one transaction, restoring the snapshot on any failure.
Run via `pocketknife migrate -app <id> -to <new.json>`.

**Seed data** (`engine/seed/`): `catalog/<app_id>/data/<entity_name>.json`
files of starter rows, loaded once — only on an app's very first boot (no
existing `data.db`). Rows can reference each other via a `"$key"` label
resolved to a real generated id; all files insert in one transaction.

**Sandboxed functions** (`engine/sandbox/`, `engine/broker/`,
`engine/consent/`) — **implemented and tested in isolation, not wired to any
entry point.** The manifest's optional `functions` key would declare a
WebAssembly module and the capabilities (`data`, `network` allow-list,
`model`) it's granted; `sandbox/` runs it under wazero with no filesystem, no
env, no raw network, behind a fixed capability-checked host ABI, with
per-invocation memory/timeout/byte-cap limits. `broker/` is the only path to
a model provider (token never reaches guest code). None of this is invoked by
the current server — no HTTP/MCP route triggers `sandbox.Invoke`, and no
catalog app declares `functions`.

**Also deferred**: `frontend` is a valid manifest key (a pre-built static
bundle to serve) but nothing serves it — the frontend-serving packages were
removed pending the `apps/web` rebuild. No auth/roles/sessions; no
OR/nesting/joins in queries; no real-time/subscriptions.

Build/run: `make build` (→ `bin/pocketknife`), `make run` (serves `catalog/`
on `127.0.0.1:8080`), `make test`/`vet`/`fmt`. `-addr` defaults to
localhost-only; binding a network interface is an explicit opt-in with no
stronger auth yet.

## 2. `catalog/hyrox` — the one live app

The only app currently in `catalog/`. `manifest.json` declares four entities
(`plan` → `workout` → `exercise` → `result`, each cascading-delete into the
next) and seven tools (`create_plan`, `add_workout`, `add_exercise`,
`read_workout`, `list_workout`, `list_exercise`, `log_exercise_result`).
`data/*.json` seeds a starter plan/workout/exercise/result set on first boot.
`skills/log-workout-result/SKILL.md` is an agent-facing skill explaining when
and how to call `log_exercise_result`. `app.description` ("Plan Hyrox training
sessions, track station exercises, and log workout results.") is a plain field
on the manifest's `app` object; `app-loader.ts` (below) reads it and falls
back to an auto-generated "`N` entity type(s), `M` tool(s)" summary when it's
absent.

## 3. `apps/runtime` — the agent runtime (Node/TypeScript)

Built on Anthropic's [Pi SDK](https://pi.dev/docs/latest/sdk)
(`@earendil-works/pi-coding-agent`) against OpenRouter as the model provider.
Two entrypoints share the same wiring:

- **`agent.ts`** — one-shot CLI (`npm start -- "<prompt>"`): loads
  capabilities, creates a backend, prints the streamed response, exits.
- **`server.ts`** — the HTTP/SSE server the web UI talks to (port 8787, `npm
  run server`).

**Capability loading** (`app-loader.ts`) has two sources, merged:
- `loadApps(appsDir)` scans `apps/<name>/app.json` — a lightweight,
  file-based app convention (name/description/emoji/color) that can
  contribute a `skills/` directory (SKILL.md files) and/or an `mcp.json`
  (a list of remote MCP servers, `${ENV_VAR}`-style header interpolation for
  secrets). No app currently ships this way; the mechanism is generic
  infrastructure inherited from the pre-engine version of this repo.
- `loadCatalogApps(catalogDir)` scans `catalog/<id>/manifest.json` — the
  **engine-backed** apps (currently just `hyrox`). For each it builds an
  `AppManifest` (name/description/emoji/color, all read straight off the
  manifest's `app` object), stashes the
  raw entities/tools on `LoadedApp.engine` (for the web UI's inspector, see
  §4), picks up that app's `skills/` the same way, and — if the manifest
  declares any `tools` — registers an MCP server pointing at
  `{ENGINE_URL}/mcp/{app_id}` (default `ENGINE_URL=http://127.0.0.1:8080`).
  If the engine isn't running, that connection just fails gracefully at query
  time; nothing here talks to the engine directly at load time.

**Agent backend** (`agent-backend.ts` defines the interface; `backends/pi.ts`
is the only implementation): wraps a Pi SDK `ModelRuntime` (models read from
`pi/models.json`) + `createAgentSession`, exposes `prompt(text, onEvent)`
(streams `text`/`thinking`/`tool_start`/`tool_end` events),
`setModel(modelId)`, `getModelId()`. The backend is swappable by design — a
one-line reassignment (`createAgentBackend = createPiAgentBackend`) in both
`agent.ts` and `server.ts` — though only one backend exists today.

**Capability provider** (`backends/pi-capabilities.ts`): assembles a
`ResourceLoader` (so the agent can read installed apps' SKILL.md files) and a
tool list from `Capabilities`, kept separate from backend/session wiring so
new capability types can be added independently.

**MCP proxy tool** (`mcp-tools.ts`): rather than registering every tool from
every configured MCP server as its own Pi tool (costing each tool's full
schema on every request), it connects to all configured servers up front and
exposes **one** tool, `mcp`, with five actions —
`mcp({})` list servers, `mcp({server})` list a server's tools,
`mcp({search})` keyword search across all servers, `mcp({describe})` full
parameter schema for one tool, `mcp({tool, args, server?})` call one. A
server that fails to connect is skipped with a logged warning, not a fatal
error; large results are truncated to 4000 chars. This is the seam through
which the agent calls hyrox's engine-exposed tools.

**`server.ts` HTTP surface** (all responses CORS-open, `*`):
| Route | Behavior |
|---|---|
| `GET /api/apps` | all loaded apps (file- and catalog-based), as DTOs |
| `GET /api/apps/:id/tools` \| `/skills` \| `/entities` | that app's engine tools/entities, or its parsed SKILL.md files |
| `GET /api/apps/:id/data/:entity` | proxies straight through to the engine's `GET /apps/{id}/{entity}` (query string forwarded verbatim) |
| `GET /api/models` / `POST /api/model` | curated model list from `pi/models.json` / switch the live session's model |
| `POST /api/chat` | SSE stream of agent events for one prompt; a `409` if a previous stream is still in flight (single in-flight request, no queuing) |

## 4. `apps/web` — the frontend (React 19 + Vite 7 + TypeScript)

A single-page app, three routes (`App.tsx` via `react-router-dom` v7):

| Route | Page | Purpose |
|---|---|---|
| `/` | `AgentPage` | chat with the agent |
| `/apps` | `AppsPage` | list of installed apps, searchable |
| `/apps/:id` | `AppDetailPage` | inspect one app: its tools, skills, and live data |

Styling: Tailwind CSS v4 (`@tailwindcss/vite`, no config file — tokens live
in `src/styles/globals.css` as CSS custom properties) with a custom
`fern`/`paper` palette plus risograph-style accent colors ("Fortynine" design
system, per the file's header comment), a `.dark` variant, dark/light
persisted via `lib/theme.tsx` and toggled from the sidebar. UI primitives
(`components/ui/`) are a shadcn/Radix-style kit — accordion, alert, avatar,
badge, button, card, checkbox, dialog, dropdown-menu, field, input, label,
popover, progress, radio-group, select, separator, skeleton, slider, switch,
table, tabs, toast (via `sonner`), tooltip — plus bespoke pieces built for the
agent UI specifically: `chat.tsx` (`Conversation`/`Message`/`MessageContent`/
`MessageMeta` layout primitives), `prompt-input.tsx` (the composer, submit
via Enter, `Suggestions` chips), `tool-call.tsx` (collapsible tool-call
card with a status icon and duration badge), `thinking.tsx` (collapsible
reasoning block with elapsed time), `streaming.tsx` (blinking caret while
text is still arriving), `markdown.tsx`/`code-block.tsx` (`react-markdown` +
`remark-gfm` rendering), `doodle.tsx` (small decorative SVGs for empty
states), `agent-status.tsx`/`approval.tsx`/`article-card.tsx` (present, not
yet wired into any page).

**`AgentPage`** — the chat UI. Local state models each turn as either a user
message or an assistant turn made of ordered `Segment`s (`thinking`, `tool`,
`text`) folded live from `AgentStreamEvent`s via `appendEvent`; consecutive
tool-call segments collapse into one expandable group
(`groupSegments`/`toolGroupLabel`) so ten sequential `add_exercise` calls
render as "10 × hyrox.add_exercise" instead of ten cards. Because every
app/tool call is routed through the single `mcp` proxy tool (§3),
`toolCallLabel` reads the tool's actual `args` (`tool`, `server`, `search`,
`describe`) to show what it's really doing rather than the literal string
`"mcp"` for every call. A model picker (sourced from `GET /api/models`) and
an "in context" strip listing installed apps sit around the composer;
sending calls `streamChat` (`lib/api.ts`), an `AbortController` wired to a
stop button.

**`AppsPage`** — fetches `GET /api/apps`, renders a searchable (client-side
filter on name/description) list of app rows (emoji tile, name, description,
an "Installed" badge), each linking to `/apps/:id`.

**`AppDetailPage`** — three tabs per app, each independently loaded:
- *Tools* — `GET /api/apps/:id/tools`, one accordion item per tool showing
  its param table (name/type/required).
- *Skills* — `GET /api/apps/:id/skills`, one accordion item per skill
  rendering its SKILL.md body as markdown.
- *Data* — `GET /api/apps/:id/entities` populates an entity picker; picking
  one calls `GET /api/apps/:id/data/:entity` (capped at 200 rows, matching
  the engine's own list cap) and renders it through a `@tanstack/react-table`
  instance with client-side sort/filter/pagination (`EntityTable`) — the only
  place in the current UI that reads engine-owned row data directly. This tab
  is read-only; there is no create/update/delete UI yet.

**`lib/api.ts`** is the single fetch layer for all of the above — every
endpoint in the `server.ts` table plus `streamChat`, which parses the
`POST /api/chat` SSE stream by hand (buffers on `\n\n`, extracts the `data:`
line, `JSON.parse`s it) rather than using `EventSource` (needed since it POSTs
a body, which `EventSource` can't do).

**Dev wiring**: `vite.config.ts` proxies `/api/*` to `http://localhost:8787`
(no CORS needed in dev); in a built/served deployment the runtime's CORS
headers (`Access-Control-Allow-Origin: *`) are what make cross-origin calls
work instead.

## 5. `pi/models.json` — curated model list

A static, hand-maintained catalog of OpenRouter models surfaced in the model
picker: id, display name, `tier` (frontier/balanced/cheap), whether it
supports reasoning, context window, and per-token cost
(input/output/cacheRead/cacheWrite) — currently ten entries spanning Claude
Opus 5/Sonnet 5, GPT-5.6, GLM-5.3, Qwen3.8, Gemini 3.7, Grok 4.6, Kimi K3, and
DeepSeek V4. `server.ts`'s `/api/models` reads this file directly (not
through the Pi SDK's runtime) purely for display metadata; the Pi SDK's own
`ModelRuntime` (same file, different consumer) is what actually resolves a
model id to a callable model for the agent session. Default model:
`z-ai/glm-5.3-flash`.

## What's not implemented

- **No write path from the web UI** — the data tab is read-only; creating/
  editing rows requires calling the engine's HTTP API directly or going
  through the agent's tools.
- **No auth anywhere** — engine, runtime server, and web app all assume a
  trusted local machine.
- **Sandboxed functions** (`engine/sandbox/`) are unreachable from any live
  route — see above.
- **File-based `apps/*/app.json` capability convention** (skills/MCP servers
  outside the engine) exists in code but no app currently uses it — only the
  engine-backed catalog path is populated today.
- **`AgentStatus`, `Approval`, `ArticleCard` UI components** exist but aren't
  used by any page yet.
- The old build/activation/deploy/shell layer described in the rest of
  `docs/` and in most of `openspec/` is gone; nothing in this list is a
  regression against it because that was a different, now-removed system.
