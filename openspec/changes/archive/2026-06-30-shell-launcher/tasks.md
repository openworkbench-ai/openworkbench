## 1. Platform database — app_meta table

- [x] 1.1 Add `app_meta` table DDL to `build/store.go`: columns `app_id TEXT PRIMARY KEY`, `emoji TEXT`, `color TEXT`, `display_name TEXT`, `grid_order INTEGER`, `updated_at TEXT`
- [x] 1.2 Add `UpsertAppMeta` / `GetAppMeta` / `ListAppMeta` methods to `build.Store`
- [x] 1.3 Add `ReorderApps` method to `build.Store` for bulk grid_order update
- [x] 1.4 Wire upsert call in registry load path so every registered app gets a default row
- [x] 1.5 Wire upsert call in `deployapi` after a successful `build.Bootstrap` so new deploys auto-register metadata

## 2. Platform registry API (Go)

- [x] 2.1 Create `platform/` Go package with `NewServer(bst *build.Store, reg *registry.Registry) http.Handler`
- [x] 2.2 Implement `GET /platform/registry` — query `ListAppMeta`, join with live build status from `build.Store`, return JSON array sorted by `grid_order`
- [x] 2.3 Implement `PATCH /platform/registry/{appId}` — validate fields, call `UpsertAppMeta`, return updated entry
- [x] 2.4 Implement `POST /platform/registry/reorder` — validate all app ids exist, call `ReorderApps`
- [x] 2.5 Mount `platform.NewServer` at `/platform/` in `cmd/pocketknife/main.go`

## 3. Session authentication (Go)

- [x] 3.1 Create `platform/auth.go` with password bootstrap logic: read `POCKETKNIFE_ADMIN_PASSWORD` env, generate and print if absent, bcrypt-hash at startup
- [x] 3.2 Implement in-memory session store: token → expiry map, TTL 24h, sliding renewal on each valid request
- [x] 3.3 Implement `POST /platform/auth/login` — compare password with constant-time bcrypt, 200ms floor on failure, issue HttpOnly SameSite=Strict cookie
- [x] 3.4 Implement `POST /platform/auth/logout` — expire cookie, invalidate token from store
- [x] 3.5 Implement auth middleware that wraps `/platform/` routes (exempt: `/platform/auth/login`, `/platform/auth/logout`)
- [x] 3.6 Apply auth middleware in `platform.NewServer`

## 4. Bridge mode in the Node agent

- [x] 4.1 Add `--bridge-mode` flag parsing to `agent/src/cli.ts`
- [x] 4.2 Create `agent/src/bridge.ts` — stdin reader that parses newline-delimited JSON messages and emits them as events to the planning loop
- [x] 4.3 Add bridge-mode output adapter in `agent/src/cli.ts`: intercept planner output and format as JSON event lines on stdout instead of human-readable prose
- [x] 4.4 Emit `{"type":"turn","role":"assistant","text":"..."}` on each planner assistant message
- [x] 4.5 Emit `{"type":"plan","checklist":[...]}` when `validate_manifest` succeeds (parse features from the generated client or plan summary)
- [x] 4.6 Emit `{"type":"ready","manifestVersion":<n>}` when `ready_to_build` is called
- [x] 4.7 Emit `{"type":"done"}` on clean exit; `{"type":"error","reason":"..."}` on fatal errors
- [x] 4.8 Handle `{"type":"approve"}` stdin message: resume the build submission flow (currently triggered by user typing "build it")
- [x] 4.9 Verify existing CLI path (no `--bridge-mode`) is unaffected by changes

## 5. Agent bridge HTTP endpoints (Go)

- [x] 5.1 Create `platform/plan.go` — session registry (UUID → subprocess handle + event buffer + subscribers)
- [x] 5.2 Implement `POST /platform/plan` — validate body, spawn agent subprocess with `--bridge-mode` [+ `--app {appId}` if provided], register session, return 201 `{"sessionId":"..."}`
- [x] 5.3 Implement subprocess stdout reader goroutine — parse JSON event lines, append to session event buffer (max 50), fan out to SSE subscribers
- [x] 5.4 Implement `GET /platform/plan/{sessionId}/events` — SSE handler, send buffered events from `Last-Event-ID`, stream new events, enforce max-4-subscribers limit
- [x] 5.5 Implement `POST /platform/plan/{sessionId}/message` — write JSON message line to subprocess stdin, return 202 or 409
- [x] 5.6 Implement `POST /platform/plan/{sessionId}/approve` — check session is in ready state, write `{"type":"approve"}` to stdin, return 202 with appId
- [x] 5.7 Implement session timeout cleanup (30-minute inactivity ticker, kill subprocess, emit error event)
- [x] 5.8 Mount plan routes in `platform.NewServer`

## 6. Shell SPA project scaffold

- [x] 6.1 Create `shell/` directory with `package.json` (React 18, TypeScript, Vite, Tailwind, Radix UI, Framer Motion — same versions as `agent/templates/frontend`)
- [x] 6.2 Add `vite.config.ts` with SPA fallback and dev proxy (`/platform/`, `/apps/`, `/builds/`, `/ui/` proxied to `:8080`)
- [x] 6.3 Add `tailwind.config.ts` with Pocketknife design tokens: cream palette, terracotta accent, dark mode variants, Space Grotesk + Space Mono font families, squircle border-radius scale
- [x] 6.4 Add Space Grotesk and Space Mono font subsets (woff2) to `shell/public/fonts/` and reference in `tailwind.config.ts` / global CSS
- [x] 6.5 Add `src/main.tsx`, `src/App.tsx` with React Router routes: `/login`, `/home`, `/plan/:sessionId`, `/app/:appId`
- [x] 6.6 Add `src/lib/api.ts` — typed fetch wrappers for all `/platform/` endpoints (registry, auth, plan)
- [x] 6.7 Add `src/lib/useRegistry.ts` — hook that fetches and polls `/platform/registry` every 3 s when any app is in a non-terminal build state

## 7. Shell screens

- [x] 7.1 Implement Screen 01 Login (`src/screens/Login.tsx`) — wordmark, tagline, password input, "Sign in →", redirect if already authed
- [x] 7.2 Implement `PrivateRoute` guard that redirects to `/login` if no valid session
- [x] 7.3 Implement Screen 02 Home Launcher (`src/screens/Home.tsx`) — greeting, user avatar, filter tabs, "Jump Back In" card (localStorage), app grid, floating bottom nav
- [x] 7.4 Implement `AppTile` component — colored squircle with emoji, display name, progress ring overlay in building state, error badge in failed state
- [x] 7.5 Implement Screen 03 New App Sheet (`src/components/NewAppSheet.tsx`) — bottom-sheet modal, Describe/Paste tabs, text area, character counter, suggestion pills, Create button
- [x] 7.6 Implement Screen 04 Plan Review (`src/screens/PlanReview.tsx`) — session SSE connection, chat transcript, plan checklist, "Looks good — build it →" CTA, message input
- [x] 7.7 Implement Screen 05 Building State (inline in Home screen) — "Building N app…" banner, progress percentage derived from build stage, pocketPulse animation
- [x] 7.8 Implement Screen 06 App Inside View (`src/screens/AppView.tsx`) — back button, header bar, iframe pointing at `/ui/{appId}/` with sandbox attribute, inline "ask to change" prompt bar
- [x] 7.9 Implement light/dark theme switching via `prefers-color-scheme` and Tailwind `dark:` variants
- [x] 7.10 Add `src/components/BottomNav.tsx` — floating dark pill nav with four icon slots and active-state highlight

## 8. Go serve integration

- [x] 8.1 Add `shell.NewServer(distDir string) http.Handler` in a `shell/` Go package — serves `shell/dist/` with SPA fallback to `index.html`
- [x] 8.2 Mount `shell.NewServer` at `/` in `cmd/pocketknife/main.go`, ordered after all other routes so specific routes take precedence
- [x] 8.3 Add `-shell-dist` flag to the serve subcommand (default `shell/dist`) so the path is configurable
- [x] 8.4 Add `make shell-build` target in `Makefile` to compile the shell (`npm run build` in `shell/`) and ensure the output lands in `shell/dist/`
- [x] 8.5 Update `make build` to depend on `shell-build` so the production binary always includes a fresh shell

## 9. End-to-end tests and documentation

- [x] 9.1 Add Go tests for `platform.Store` methods (app_meta CRUD + reorder)
- [x] 9.2 Add Go tests for `platform` auth handler (login, logout, guard middleware)
- [x] 9.3 Add Go tests for registry API handler (list, patch, reorder)
- [x] 9.4 Add Node unit tests for bridge mode output format (`agent/src/bridge.test.ts`)
- [x] 9.5 Extend `test_project_hub.sh` with a smoke test for `GET /platform/registry` and `POST /platform/auth/login`
- [x] 9.6 Document bridge protocol in `docs/bridge-protocol.md` (event types, stdin format, lifecycle)
- [x] 9.7 Add shell dev-start instructions to `CLAUDE.md` (run Go with `-cors`, run `npm run dev` in `shell/`)
