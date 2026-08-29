## Context

The factory is complete: a manifest produces a running app with a database, CRUD API, generated TypeScript client, and an activated frontend bundle served at `/ui/{appId}/`. The agent CLI can author manifests conversationally and submit them. What doesn't exist is the shell — the surface a person actually uses.

The design reference is `docs/design` (HTML): six screens in an editorial flat iOS-inspired style with Space Grotesk font, light and dark themes. The shell is the most trusted, most privileged surface in the system and is deliberately exempt from the sandbox.

Current state of relevant pieces:
- `platform.db` stores build jobs and active-build pointers. No per-app display metadata (emoji, color) anywhere.
- `build.NewStatusServer` serves `/builds/` (job states), but requires polling; no SSE.
- The agent runs as a CLI process; its planning loop is stdio-bound.
- The Go binary doesn't serve anything at `/` today.
- Auth does not exist; all endpoints are open.

## Goals / Non-Goals

**Goals:**
- Six-screen shell SPA matching the `docs/design` reference (login, home launcher, new-app sheet, plan review, building state, app-inside view).
- Platform registry API: per-app emoji/color/display-name/grid-order stored and served, so the launcher grid has its data.
- Session auth wall on `/platform/` routes: single-user, password bootstrap, HttpOnly cookie.
- Agent bridge: web-driven planning loop via HTTP+SSE so the plan-review screen doesn't need the CLI.
- Production: Go binary serves compiled shell at `/`; dev: shell on `:3001` with CORS.

**Non-Goals:**
- Magic-link / SMTP (Phase 8 hardening).
- Multi-user, per-app auth, or RBAC.
- Shared component kit distributed to generated apps (can follow; not in this change).
- Real-time collaboration or websockets (SSE is sufficient).
- Sandboxed functions HTTP endpoint (Phase 4 wiring, separate change).

## Decisions

### 1. Shell as a separate `shell/` project, not merged into `agent/`

The agent is a backend CLI process (Node, no DOM). The shell is a browser SPA. They share no runtime or tooling. Merging them would couple a CLI tool to a frontend bundler and confuse the mental model.

`shell/` mirrors the structure of `agent/templates/frontend`: Vite, React 18, TypeScript, Tailwind, Radix UI. This keeps the stack consistent with what the agent builds, which matters for later component kit sharing.

**Alternative rejected**: monorepo with shared `packages/` — premature until the component kit is actually extracted.

### 2. `app_meta` table added to `platform.db`, not to manifests

Emoji, color, and grid order are display/personalization data — they change independently of the app's schema. A manifest is a technical spec; adding UI chrome to it pollutes its semantics and forces a re-validate/re-deploy on every emoji change.

`platform.db` already owns app-level lifecycle state (build jobs, active builds). Adding `app_meta` there is coherent and keeps per-app `data.db` files as pure data planes.

Migration: `build.Open` runs `CREATE TABLE IF NOT EXISTS app_meta (...)` alongside the existing DDL. No data loss risk; additive.

**Alternative rejected**: new separate `shell.db` — unnecessary split; `platform.db` is already the platform-level store.

### 3. Session auth: static/env password, no magic-link yet

Magic-link requires working SMTP, which is Phase 8 (self-host hardening). For Phase 7 the single-user model lets us get away with a simple `POCKETKNIFE_ADMIN_PASSWORD` env var (bcrypt-hashed at boot, compared on login). A random session token stored in a server-side map (with TTL) is issued as an HttpOnly, SameSite=Strict cookie.

Scope: only `/platform/` routes are gated. `/apps/`, `/ui/`, `/builds/`, `/validate`, `/deploy`, `/export/` remain open — on localhost single-user this is acceptable, and locking them down would break the CLI agent and existing test scripts. This is explicitly revisited in Phase 8.

**Alternative rejected**: HTTP Basic Auth — not browser-friendly; no logout mechanism.

### 4. Agent bridge: process spawn + stdio adaptation

The existing agent is a battle-tested CLI tool with validation, repair loops, and stable-ID logic. Rewriting it as a library would be a large refactor with no user-facing benefit.

The bridge (`platform/plan`) manages agent subprocesses: one process per active planning session, identified by a UUID `sessionId`. The Go bridge writes user messages to the subprocess stdin and reads structured JSON events from stdout. The agent is given `--bridge-mode` flag that switches output from human-readable to newline-delimited JSON events (`{type:"turn"|"plan"|"ready"|"error", ...}`).

SSE stream at `GET /platform/plan/{sessionId}/events` fans out events to any connected client. Sessions time out after 30 minutes of inactivity; the subprocess is killed and cleaned up.

**Alternative rejected**: HTTP callback from agent to Go — requires the agent to know the server address and adds a round-trip; stdin/stdout is a simpler and more contained IPC.

### 5. Build progress: SSE from `build.NewStatusServer`, not polling

The building state screen needs live progress. Extending `/builds/{jobId}` to support `text/event-stream` requests keeps everything in the existing package. The shell polls every 2 s as a fallback if SSE isn't available (progressive enhancement).

### 6. App-inside view: `<iframe>` pointing at `/ui/{appId}/`

The activated frontend for each app is already served at `/ui/{appId}/`. Wrapping it in an iframe gives instant isolation, avoids CSS bleed, and lets the shell's navigation chrome (back button, app header, inline chat input) live outside the app's document.

**Security**: the iframe gets `sandbox="allow-scripts allow-same-origin allow-forms"` — same origin means the app's own fetch calls work; the outer shell is same-origin so postMessage is available for future inline-chat replies.

### 7. "Jump Back In" card: last-opened tracked client-side in localStorage

The launcher shows a "Jump Back In" shortcut to the most recently opened app. This is purely client-side — no API required, no server state. Storing it in localStorage avoids a round-trip and keeps the server stateless for this feature.

## Risks / Trade-offs

- **Agent bridge process lifecycle** → If the Go server restarts, all in-flight planning sessions are lost. Mitigation: the shell detects a closed SSE stream and shows a reconnect prompt; the plan checklist in the UI preserves what was already agreed before the restart.
- **Auth scope (open app APIs)** → `/apps/` and `/ui/` are unprotected. On a self-hosted single-user box accessible only on LAN this is acceptable; if the box is internet-exposed, it's a real gap. Mitigation: documented as a known gap; addressed in Phase 8 with proper auth scoping and magic-link.
- **iframe sandbox vs. app capabilities** → Some generated apps may use localStorage or cookies for their own state. `allow-same-origin` in the sandbox attribute permits this; a future tighter sandbox would require explicit opt-in. Mitigation: current apps (pure CRUD via client.ts) don't use browser storage beyond the generated client.
- **Space Grotesk font loading** → The design uses a Google Fonts CDN link. On a self-hosted NAS without internet access the font silently degrades. Mitigation: bundle the font subset in `shell/public/fonts/` and reference it locally; CDN is a fallback.

## Migration Plan

1. `platform.db` schema: `build.Open` gets `app_meta` table DDL — additive, safe at any point.
2. `platform/` Go package and routes added to `main.go` — new routes, no conflicts.
3. Shell SPA built and placed in `shell/dist/`; `main.go` picks it up at boot via `http.FileServer`.
4. Agent gets `--bridge-mode` flag — backward compatible; CLI usage unchanged.
5. No existing routes change. No DB file changes to per-app `data.db`. No manifest format changes.

## Open Questions

- **`POCKETKNIFE_ADMIN_PASSWORD` absent at boot**: panic and refuse to start, or generate a random one and print it once to stdout? Printing once is safer for first-run UX but could be missed in a log. Decision needed before implementation.
- **SSE session fan-out**: if the user has two browser tabs open on the plan review, both should receive events. A simple slice of channels per sessionId handles this; confirm capacity limit (suggest: max 4 connections per session, 5th gets 429).
- **`--bridge-mode` event schema**: needs to be agreed between the Go bridge and the agent before either side is implemented. Propose defining it in a shared `docs/bridge-protocol.md` first.
