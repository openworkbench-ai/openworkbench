# openworkbench

A minimal agent built with Anthropic's [Pi SDK](https://pi.dev/docs/latest/sdk), running against OpenRouter as the model provider.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY=sk-or-...
export $(cat .env | xargs)
```

### Accounts

Every API and agent capability requires an account (email + password). The first
account you create always works, and it inherits any apps that already exist in
`catalog/`. After that, sign-ups are closed unless you set `ALLOW_SIGNUP=true`.

Each user has their own apps, app data, chat, and build conversation: an app is
visible only to the account that built it, and one user can't read or open
another's. Passwords are stored as salted scrypt hashes; a login sets an
HTTP-only, `SameSite=Strict` session cookie (7 days) backed by a server-side
session, so signing out takes effect immediately.

Tenancy and login are deliberately separate. The core only asks an
`AuthProvider` (`apps/runtime/auth-provider.ts`) "who is this request from?" and
records which user id owns which app (`data/ownership.db`, override with
`OWNERSHIP_DB_PATH`). The built-in email/password provider keeps its accounts and
sessions in `data/auth.db` (`AUTH_DB_PATH`). To use a hosted provider (Clerk,
WorkOS, an OIDC IdP, ...), implement `AuthProvider` and construct it in
`server.ts` instead — ownership keeps working as long as its user ids stay stable.
Keep the `data/` directory on a persistent volume and back it up.

## Run

```bash
npm start -- "What files are in the current directory?"
```

The model used is configured in `pi/models.json` (defaults to `z-ai/glm-5.3-flash` via OpenRouter) — swap `id` to any OpenRouter model slug.

## Deploy with Docker

The repo ships a `compose.yml` that runs the three pieces (`engine/`, `apps/runtime`, `apps/web`) as separate containers, wired together on an internal Docker network. Nothing but the web UI is published to the host.

```bash
cp .env.example .env
# edit .env: set OPENROUTER_API_KEY (and ALLOW_SIGNUP=true if others should be able to sign up)
docker compose up -d --build
```

The UI is then reachable at `http://127.0.0.1:8788` (override with `WEB_BIND`/`WEB_PORT` in `.env`). Put your own reverse proxy (nginx, Caddy, Traefik, a Cloudflare Tunnel, ...) in front of that port for anything beyond local access — this app does not terminate public TLS itself.

Persistent data lives in Docker volumes: the engine's per-app SQLite databases in `openworkbench_data`, and accounts/sessions in `openworkbench_runtime`. `catalog/` is bind-mounted read-write from your checkout into both `engine` and `runtime`, since the in-app build agent writes newly authored apps straight into it. Only `catalog/hyrox` (the shipped example app) is tracked in git; everything else under `catalog/` is gitignored by default, so apps you build or the agent builds for you stay local unless you explicitly `git add` them.

To point the data volume at a specific host path instead of a Docker-managed volume (e.g. to keep it on a separate disk), add a gitignored `compose.override.yml`:

```yaml
services:
  engine:
    volumes:
      - ./catalog:/catalog
      - openworkbench_data:/data

volumes:
  openworkbench_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /path/to/your/data/dir
```

## Apps and capabilities

Catalog apps can also expose Python functions as agent tools, executed as
WebAssembly inside the Go engine. See [Python function tools](docs/python-tools.md)
for the manifest format, setup, limits and a complete example.

The agent gains capabilities from **apps** — self-contained directories under `apps/<app-name>/` with a manifest:

```json
// apps/<app-name>/app.json
{ "name": "my-app", "description": "What this app is for." }
```

`src/app-loader.ts` scans `apps/` at startup, reads each manifest, and aggregates the capabilities apps contribute into a `Capabilities` object. That object is passed into the backend (`createPiAgentBackend(capabilities)` in `src/backends/pi.ts`), which wires it into the underlying SDK — so capability *loading* stays independent of which agent backend is running. This is the seed of the app runtime: today the capability types are skills and MCP servers; more (prompts, etc.) can be added the same way — a new subfolder/file convention plus a new field on `Capabilities`.

### Skills

An app contributes skills via an `apps/<app-name>/skills/<skill-name>/SKILL.md` file:

```markdown
---
name: my-skill
description: When to use this skill (the model reads this to decide relevance).
---

Instructions the model follows once it loads this file.
```

The model sees only the name/description up front and uses the `read` tool to load a skill's full instructions when a prompt matches its description. See `apps/pirate-voice/` for a working example.

### MCP servers

An app contributes one or more remote MCP servers via an `apps/<app-name>/mcp.json` file, using the same `mcpServers` map convention as Claude/Cursor's `.mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_SERVER_TOKEN}" }
    }
  }
}
```

`headers` values written as `${ENV_VAR}` are resolved from the environment at load time (via `.env`), so tokens never need to live in the committed file.

Rather than registering every MCP tool from every server as its own Pi tool — which costs each tool's full schema on every request regardless of use, and stops scaling once you have several servers — `src/mcp-tools.ts` connects to all configured servers up front (over Streamable HTTP, via `@modelcontextprotocol/sdk`) and exposes them through **one** proxy tool, `mcp`, inspired by [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)'s approach:

- `mcp({})` — list connected servers and how many tools each has.
- `mcp({ server: "name" })` — list that server's tools.
- `mcp({ search: "keyword" })` — search tool names/descriptions across all servers.
- `mcp({ describe: "tool_name" })` — show a tool's full parameter schema.
- `mcp({ tool: "tool_name", args: {...} })` — call a tool (add `server` to disambiguate if two servers share a tool name).

A server that fails to connect is skipped with a warning rather than failing the whole run; its tools just won't show up in `list`/`search`. Large tool results are truncated to keep a single call from blowing up context. See `apps/hyrox/` for a working example.

## CI/CD

- `.github/workflows/ci.yml` runs `go vet`/`go test` for `engine/` and builds `apps/web` + tests `apps/runtime` on every push and pull request.
- `.github/workflows/docker-publish.yml` runs on every push to `main`: it re-runs CI, then builds and pushes multi-arch (`amd64`/`arm64`) images to GHCR as `ghcr.io/openworkbench-ai/openworkbench-{web,runtime,engine}:latest` and `:sha-<short>`, and finally fires a `repository_dispatch` to the private [`openworkbench-deploy`](https://github.com/openworkbench-ai/openworkbench-deploy) repo to trigger a deploy. This requires a `DEPLOY_REPO_DISPATCH_TOKEN` repo secret — a PAT with `repo` scope on `openworkbench-deploy`.
