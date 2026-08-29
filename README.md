# openworkbench

A minimal agent built with Anthropic's [Pi SDK](https://pi.dev/docs/latest/sdk), running against OpenRouter as the model provider.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY=sk-or-...
export $(cat .env | xargs)
```

## Run

```bash
npm start -- "What files are in the current directory?"
```

The model used is configured in `pi/models.json` (defaults to `z-ai/glm-5.3-flash` via OpenRouter) — swap `id` to any OpenRouter model slug.

## Apps and capabilities

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
