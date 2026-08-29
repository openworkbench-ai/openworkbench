## Why

The factory (phases 0–6) is complete end-to-end, but the only way to create, monitor, and open apps is via the CLI agent and raw API calls. The shell — the hand-built, trusted launcher surface — needs to exist so Pocketknife is actually usable as a product. The design file (`docs/design`) defines six screens in detail; this change implements them.

## What Changes

- New `shell/` TypeScript project: a React+Vite SPA with six screens matching the design (login, home launcher, new-app sheet, plan-review chat, building state, app-inside view).
- New `platform/` Go package and `/platform/` HTTP routes: persists per-app display metadata (emoji, color, display name, grid order) in `platform.db` and serves it alongside build status for the launcher grid.
- Session auth: single-user, password-set-on-first-boot, HttpOnly-cookie session. Locks down all `/platform/` routes; magic-link/SMTP is Phase 8.
- Agent bridge: new `/platform/plan` HTTP endpoint + SSE stream that spawns and proxies the Node agent's planning loop, allowing the web plan-review screen to drive the agent conversationally without touching the CLI.
- Go serve integration: in production the Go binary serves the compiled shell bundle at `/`; dev runs shell on `:3001` with CORS to the Go API on `:8080`.

## Capabilities

### New Capabilities

- `platform-registry-api`: Platform metadata API — per-app emoji/color/display-name/order stored in `platform.db`, exposed via `GET /platform/registry` (list with live build status) and `PATCH /platform/registry/{appId}` (update display fields). This is the data source the launcher grid reads.
- `shell-auth`: Single-user session authentication — bootstrap password set on first boot (or env var), session token issued as an HttpOnly cookie, `/platform/` routes protected, `/login` always public. App APIs and `/ui/` remain auth-exempt in this phase (single-user on localhost).
- `shell-frontend`: React TypeScript SPA with six screens: 01 login, 02 home launcher (emoji tile grid, "Jump Back In" card, tab filters, bottom nav), 03 new-app sheet (describe/paste tabs, suggestion pills), 04 plan-review chat (streaming agent turns, plan checklist, approve-to-build CTA), 05 home with building tile (progress ring, stage text), 06 app-inside view (back nav, iframe for `/ui/{appId}/`, inline "ask to change" form). Light + dark themes, Space Grotesk font, editorial flat style per `docs/design`.
- `shell-agent-bridge`: HTTP adapter that manages agent planning sessions for the web shell — `POST /platform/plan` starts a new planning session (returns `sessionId`), `POST /platform/plan/{sessionId}/message` sends a user turn, `GET /platform/plan/{sessionId}/events` streams agent turns and plan state as SSE. Internally spawns/resumes the Node agent process and adapts its stdio to the HTTP seam.

### Modified Capabilities

- `agent-deploy-ingest`: The deploy HTTP seam (`POST /deploy`) is unchanged, but the shell's approve-to-build action now drives it from the browser rather than CLI approval — no protocol change, but the consumer changes.

## Impact

- **New code**: `shell/` (TypeScript SPA ~6 screens), `platform/` Go package (registry metadata + auth + agent bridge), `cmd/pocketknife/main.go` (wire new routes, serve shell static assets at `/`).
- **`build/store.go`**: schema migration to add `app_meta` table to `platform.db` (emoji, color, display_name, grid_order per app_id).
- **Dependencies**: `shell/` gets its own `package.json` — same React/Tailwind/Radix stack as `agent/templates/frontend`; no new Go deps.
- **No breaking changes to existing APIs**: `/apps/{id}/...`, `/ui/{id}/...`, `/builds/...`, `/deploy`, `/export/` shapes are unchanged.
