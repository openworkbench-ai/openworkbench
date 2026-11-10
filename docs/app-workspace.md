# App workspace

Each app is a durable project with an editable draft and a running revision. The
app page is its home: Overview, Code, Preview, Data, Changes, History, and a coding
partner. `/build` redirects to Apps; new apps start in this same workspace.

## The experience

- The overview is derived from source, showing the data model, tools, skills,
  components, functions, their connections, and function capabilities. Its Draft /
  Live switch makes the version being described explicit.
- The source explorer and Monaco editor expose real JSON, Markdown, React,
  TypeScript helpers, and Python files. The manifest uses the engine's canonical
  JSON Schema for inline diagnostics and completion. Markdown has a reading view.
- Edits autosave to the draft. Source changes can be compared with the running
  revision or individually reverted. The editor has search, formatting, undo,
  tabs, line numbers, and a save shortcut.
- The coding partner receives the app and selected file as context. Its transcript
  lives with the project; edits use the same bounded draft store as manual edits.
  It can read platform guides and validate, but has no installation, shell, or host
  filesystem tool. Model credentials are server-side. Without an
  `OPENROUTER_API_KEY`, manual editing, validation, previews and activation remain
  available and the partner shows its setup state.
- Preview compiles a component and renders it in a script-only iframe. Editable
  sample props update its display. The iframe has an opaque origin and a CSP that
  blocks network access; sample inputs never touch live records.
- Review & apply validates, shows source and schema changes and additional function
  capabilities, then activates only on the user's action. Destructive migrations
  and expanded capabilities require an explicit acknowledgment. Changes needing
  conversion/backfill witnesses are refused with an explanation; this release does
  not provide a witness editor.
- History retains the latest 20 source revisions. Restore copies a revision into
  the draft for review. It does not silently restore or overwrite database rows.

## Source contract

Editable paths are `manifest.json`, `skills/<slug>/SKILL.md`,
`ui/components/<Name>.tsx`, `ui/components/<name>.ts`, `functions/<name>.py`, and
`data/<entity>.json`. Generated types, built HTML and package caches are managed by
the platform. A project permits at most 256 files, 1 MiB per file and 4 MiB of source.
Component imports are limited to app-local UI files, generated entity types,
React, lucide-react, and the app UI kit. Raw host imports and Vite filesystem globs
are rejected before compilation. Python functions retain the engine's existing
Wasm capability and package rules.

## Persistence and concurrency

The runtime stores user-scoped project documents beneath `WORKSPACES_DIR`, default
`data/workspaces` next to the authentication database. Each document contains the
draft, baseline source, source version, revisions, edit attribution and transcript.
Writes use a same-directory temporary file and rename. Preserve this directory in
backups; the existing runtime data volume includes it in Docker Compose.

Catalog source is imported when an existing engine app is first opened. Source
revisions are distinct from `manifest.app.version`. Workspaces are the supported
editing surface after import; edits made externally to catalog files are not
synchronized into existing drafts automatically.

Mutations require the last source version, so another tab cannot silently
replace newer work. A per-project operation lock excludes manual saves during
agent editing, validation, preview compilation and activation. Build operations
materialize a fixed snapshot in a disposable directory. Unsent editor changes
have best-effort session recovery; stale recovery never automatically overwrites
newer server source. Agent credentials/cache use an isolated temporary directory.

The engine's `/admin/apps/{id}/changes` derives schema changes and permission
expansion. `/admin/apps/{id}/apply` stages the bundle, snapshots affected existing
data, runs the migration transaction, swaps source and re-registers the app. An
unsuccessful operation restores the prior source/registration; a failed first seed
cleans its newly created database so a corrected retry starts clean. An existing
disabled app remains disabled. App and entity/field stable IDs are preserved.
Administrative mutations are serialized. This is a single-runtime design;
multiple runtime replicas would need a shared operation lock and source store.

## Runtime routes

All workspace routes require the existing authenticated user. Source lookup and
ownership checks stay on the runtime; the engine remains an internal service.

| Route | Purpose |
| --- | --- |
| `GET /api/workspaces` | List this user's projects |
| `POST /api/workspaces` | Create a blank, tracker, or research project |
| `GET /api/workspaces/:id` | Read source, baseline, history, conversation and state |
| `PATCH /api/workspaces/:id` | Version-checked source patch |
| `POST /api/workspaces/:id/validate` | Manifest, source, Python, package and React checks |
| `POST /api/workspaces/:id/preview` | Compile an isolated component preview |
| `POST /api/workspaces/:id/apply` | Revalidate and activate a reviewed revision |
| `POST /api/workspaces/:id/restore` | Restore baseline or revision source into the draft |
| `POST /api/workspaces/:id/chat` | Stream the app-scoped coding partner |

## Verification

The workspace tests cover durable storage, tenant/path isolation, stale versions,
operation locking, source limits, scoped agent tools and forbidden component
imports. The engine tests cover data-preserving updates, rejected/destructive
changes, failed migrations, UI source/build co-storage, disabled state,
capability consent, and first-seed recovery.

Browser acceptance exercised creation, actual Monaco edits and autosave, reload
persistence, function creation/wiring, sandboxed React preview with editable props,
validation and launch, actual Python tool execution in Wasm, live records,
additive schema updates preserving a row, and source history restoration.

Run `npm run build -w apps/web`, `npm test -w apps/runtime`, and `go vet ./...` /
`go test ./...` in `engine`. The current cloud environment's existing
`TestPythonWasmLimits` timing assertion fails (a timed-out sleep invocation returns
in more than its 8-second wall-time threshold); the sandbox code is unchanged by
this work. The new workspace and admin tests pass. Live model generation cannot
be verified until a provider key is configured.
