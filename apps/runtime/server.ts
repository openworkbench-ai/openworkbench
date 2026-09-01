import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadApps, loadCatalogApps, readSkills, type Capabilities, type LoadedApp, type McpServerConfig } from "./app-loader.js";
import { createPiAgentBackend, DEFAULT_MODEL_ID } from "./backends/pi.js";
import { createBuildAgentBackend } from "./backends/build-agent.js";
import { resolveHeaders } from "./mcp-tools.js";
import type { AgentBackend } from "./agent-backend.js";

const APPS_DIR = new URL("..", import.meta.url).pathname;
const CATALOG_DIR = new URL("../../catalog", import.meta.url).pathname;
const MODELS_PATH = new URL("../../pi/models.json", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8787);
const ENGINE_URL = process.env.ENGINE_URL ?? "http://127.0.0.1:8080";

// Swap this to switch agent backends; both must satisfy AgentBackend.
const createAgentBackend = createPiAgentBackend;

interface ModelInfo {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function loadCuratedModels(): ModelInfo[] {
  const raw = JSON.parse(readFileSync(MODELS_PATH, "utf-8"));
  const models = raw?.providers?.openrouter?.models ?? [];
  return models.map((m: ModelInfo) => ({ ...m, id: m.id, name: m.name ?? m.id }));
}

/** Only catalog (engine-backed) apps go through the registry's active/inactive lifecycle (see engine/adminapi); file-based apps have no such concept and are always "active". */
function appToDto(app: LoadedApp, statuses: Map<string, string>) {
  const id = basename(app.dir);
  return {
    id,
    name: app.manifest.name,
    description: app.manifest.description,
    emoji: app.manifest.emoji,
    color: app.manifest.color,
    manageable: app.engine != null,
    status: app.engine != null ? statuses.get(id) ?? "active" : "active",
  };
}

/** GETs the engine's admin app list for display; if the engine is unreachable, callers fall back to "active" per app rather than failing the whole request. */
async function fetchAdminStatuses(): Promise<Map<string, string>> {
  try {
    const res = await fetch(`${ENGINE_URL}/admin/apps`);
    if (!res.ok) return new Map();
    const body = (await res.json()) as { apps?: { id: string; status: string }[] };
    return new Map((body.apps ?? []).map((a) => [a.id, a.status]));
  } catch {
    return new Map();
  }
}

type ToggleAction = "activate" | "deactivate";

/** Matches `/api/apps/:id/(activate|deactivate)`. */
function matchToggleRoute(pathname: string): { id: string; action: ToggleAction } | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "api" || segments[1] !== "apps" || !segments[2]) return null;
  const action = segments[3];
  if (action !== "activate" && action !== "deactivate") return null;
  return { id: segments[2], action };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

type AppRouteMatch =
  | { kind: "tools" | "skills" | "entities"; id: string }
  | { kind: "data"; id: string; entity: string };

/** Matches `/api/apps/:id/(tools|skills|entities)` and `/api/apps/:id/data/:entity`. */
function matchAppRoute(pathname: string): AppRouteMatch | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "apps" || !segments[2]) return null;

  const id = segments[2];
  if (segments.length === 4 && (segments[3] === "tools" || segments[3] === "skills" || segments[3] === "entities")) {
    return { kind: segments[3], id };
  }
  if (segments.length === 5 && segments[3] === "data" && segments[4]) {
    return { kind: "data", id, entity: segments[4] };
  }
  return null;
}

/** Matches `/api/apps/:id/mcp-resource` (GET) and `/api/apps/:id/mcp-call` (POST) --
 * the MCP-Apps host's own proxy into that app's real MCP server. A rendered
 * widget's iframe can't reach the engine directly (no MCP client, no CORS story
 * of its own), so it fetches its ui:// resource and calls tools back through
 * these, exactly the same way the chat agent's `mcp` proxy tool does. */
function matchMcpProxyRoute(pathname: string): { id: string; kind: "resource" | "call" } | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "api" || segments[1] !== "apps" || !segments[2]) return null;
  if (segments[3] === "mcp-resource") return { id: segments[2], kind: "resource" };
  if (segments[3] === "mcp-call") return { id: segments[2], kind: "call" };
  return null;
}

/** Opens a short-lived MCP client against one app's server -- cheap since
 * engine/mcpserver is stateless, and avoids reaching into the chat backend's
 * own long-lived `mcp` proxy tool (which is rebuilt wholesale on every
 * `reloadApps()` and isn't exposed outside its own closure). */
async function connectAppMcpClient(server: McpServerConfig): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: resolveHeaders(server.headers) },
  });
  const client = new Client({ name: "openworkbench-host", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Scans both app sources fresh and derives the DTOs the rest of main() needs. Called at boot and again on every /api/apps/reload. */
function loadCatalog(): { apps: LoadedApp[]; appsById: Map<string, LoadedApp>; capabilities: Capabilities } {
  const fileApps = loadApps(APPS_DIR);
  const catalogApps = loadCatalogApps(CATALOG_DIR);
  const apps = [...fileApps.apps, ...catalogApps.apps];
  const appsById = new Map(apps.map((app) => [basename(app.dir), app]));
  const capabilities: Capabilities = {
    skillPaths: [...fileApps.capabilities.skillPaths, ...catalogApps.capabilities.skillPaths],
    mcpServers: [...fileApps.capabilities.mcpServers, ...catalogApps.capabilities.mcpServers],
  };
  return { apps, appsById, capabilities };
}

async function main() {
  let { apps, appsById, capabilities } = loadCatalog();
  for (const app of apps) {
    console.error(`[app] loaded ${app.manifest.name}`);
  }

  let backend: AgentBackend = await createAgentBackend(capabilities, DEFAULT_MODEL_ID);
  let streaming = false;

  // The build agent never sees installed apps' capabilities -- its job is to
  // produce a new app via its own scratch workspace, not use existing ones
  // (see createBuildAgentBackend) -- so unlike `backend` above it has no
  // reload path and is created once for the process lifetime. Its own
  // `streaming` guard is independent of the chat backend's, so a build
  // conversation and a regular chat conversation never block each other.
  const buildBackend: AgentBackend = await createBuildAgentBackend(ENGINE_URL, DEFAULT_MODEL_ID);
  let buildStreaming = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await buildBackend.dispose?.();
      process.exit(0);
    });
  }

  // Re-scans app.json/manifest.json from disk and rebuilds the agent backend
  // with whatever capabilities they now declare — the mechanism that lets an
  // app be installed/activated/deactivated (see engine/adminapi) without
  // restarting this process. Guarded on `streaming`, exactly like /api/chat,
  // rather than queued: recreating the backend mid-response would pull the
  // rug out from under an in-flight tool call, and conversation history
  // lives inside the one Pi session being replaced, so a reload always
  // starts a fresh conversation — an accepted v0.1 limitation, not
  // attempted here.
  async function reloadApps(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (streaming) {
      return { ok: false, reason: "the agent is still responding to a previous message" };
    }
    const next = loadCatalog();
    apps = next.apps;
    appsById = next.appsById;
    capabilities = next.capabilities;
    for (const app of apps) {
      console.error(`[app] loaded ${app.manifest.name}`);
    }
    backend = await createAgentBackend(capabilities, backend.getModelId());
    return { ok: true };
  }

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    try {
      if (req.method === "GET" && url.pathname === "/api/apps") {
        const statuses = await fetchAdminStatuses();
        sendJson(res, 200, { apps: apps.map((app) => appToDto(app, statuses)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/apps/reload") {
        const result = await reloadApps();
        if (!result.ok) {
          sendJson(res, 409, { error: result.reason });
          return;
        }
        const statuses = await fetchAdminStatuses();
        sendJson(res, 200, { apps: apps.map((app) => appToDto(app, statuses)) });
        return;
      }

      const toggleMatch = req.method === "POST" ? matchToggleRoute(url.pathname) : null;
      if (toggleMatch) {
        const app = appsById.get(toggleMatch.id);
        if (!app) {
          sendJson(res, 404, { error: `unknown app "${toggleMatch.id}"` });
          return;
        }
        if (!app.engine) {
          sendJson(res, 400, { error: `app "${toggleMatch.id}" cannot be activated or deactivated` });
          return;
        }
        const engineRes = await fetch(`${ENGINE_URL}/admin/apps/${toggleMatch.id}/${toggleMatch.action}`, {
          method: "POST",
        });
        const body = await engineRes.text();
        res.writeHead(engineRes.status, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(body);
        return;
      }

      const appSegments = req.method === "GET" ? matchAppRoute(url.pathname) : null;
      if (appSegments) {
        const app = appsById.get(appSegments.id);
        if (!app) {
          sendJson(res, 404, { error: `unknown app "${appSegments.id}"` });
          return;
        }

        if (appSegments.kind === "tools") {
          sendJson(res, 200, { tools: app.engine?.tools ?? [] });
          return;
        }

        if (appSegments.kind === "skills") {
          sendJson(res, 200, { skills: readSkills(app.dir) });
          return;
        }

        if (appSegments.kind === "entities") {
          sendJson(res, 200, { entities: app.engine?.entities ?? [] });
          return;
        }

        if (appSegments.kind === "data") {
          const engineUrl = new URL(`/apps/${appSegments.id}/${appSegments.entity}`, ENGINE_URL);
          engineUrl.search = url.search;
          const engineRes = await fetch(engineUrl);
          const body = await engineRes.text();
          res.writeHead(engineRes.status, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(body);
          return;
        }
      }

      const mcpProxyMatch = matchMcpProxyRoute(url.pathname);
      if (mcpProxyMatch && ((req.method === "GET" && mcpProxyMatch.kind === "resource") || (req.method === "POST" && mcpProxyMatch.kind === "call"))) {
        const mcpServer = capabilities.mcpServers.find((s) => s.name === mcpProxyMatch.id);
        if (!mcpServer) {
          sendJson(res, 404, { error: `unknown app "${mcpProxyMatch.id}"` });
          return;
        }

        const client = await connectAppMcpClient(mcpServer);
        try {
          if (mcpProxyMatch.kind === "resource") {
            const uri = url.searchParams.get("uri");
            if (!uri) {
              sendJson(res, 400, { error: "uri query param is required" });
              return;
            }
            const result = await client.readResource({ uri });
            sendJson(res, 200, result);
          } else {
            const { tool, args } = JSON.parse(await readBody(req));
            if (typeof tool !== "string" || !tool) {
              sendJson(res, 400, { error: "tool is required" });
              return;
            }
            // A tool-level failure comes back as CallToolResult.isError, not an HTTP
            // error -- same convention engine/mcpserver uses -- so the widget (or
            // AppBridge's oncalltool, forwarding this straight to the view) sees a
            // normal result it can render an error state from, not a fetch rejection.
            const result = await client.callTool({ name: tool, arguments: args ?? {} });
            sendJson(res, 200, result);
          }
        } finally {
          await client.close();
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/models") {
        sendJson(res, 200, { models: loadCuratedModels(), current: backend.getModelId() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/model") {
        const { modelId } = JSON.parse(await readBody(req));
        if (typeof modelId !== "string" || !modelId) {
          sendJson(res, 400, { error: "modelId is required" });
          return;
        }
        await backend.setModel(modelId);
        sendJson(res, 200, { current: backend.getModelId() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const { message } = JSON.parse(await readBody(req));
        if (typeof message !== "string" || !message.trim()) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }
        if (streaming) {
          sendJson(res, 409, { error: "the agent is still responding to a previous message" });
          return;
        }

        streaming = true;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        try {
          await backend.prompt(message, (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          });
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          res.write(`data: ${JSON.stringify({ type: "error", reason })}\n\n`);
        } finally {
          streaming = false;
          res.end();
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/build-chat") {
        const { message } = JSON.parse(await readBody(req));
        if (typeof message !== "string" || !message.trim()) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }
        if (buildStreaming) {
          sendJson(res, 409, { error: "the build agent is still responding to a previous message" });
          return;
        }

        buildStreaming = true;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        try {
          await buildBackend.prompt(message, (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          });
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          res.write(`data: ${JSON.stringify({ type: "error", reason })}\n\n`);
        } finally {
          buildStreaming = false;
          res.end();
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/build-chat/answer") {
        const { toolCallId, answers } = JSON.parse(await readBody(req));
        if (typeof toolCallId !== "string" || !toolCallId || !Array.isArray(answers)) {
          sendJson(res, 400, { error: "toolCallId and answers are required" });
          return;
        }
        const resolved = buildBackend.respondToTool?.(toolCallId, answers) ?? false;
        if (!resolved) {
          sendJson(res, 404, { error: `no pending question with toolCallId "${toolCallId}"` });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/build-chat/draft/")) {
        const id = url.pathname.slice("/api/build-chat/draft/".length);
        const draft = id ? buildBackend.readDraft?.(id) ?? null : null;
        if (!draft) {
          sendJson(res, 404, { error: `no draft "${id}" in the build agent's workspace` });
          return;
        }
        sendJson(res, 200, draft);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/build-chat/install") {
        const { id } = JSON.parse(await readBody(req));
        if (typeof id !== "string" || !id) {
          sendJson(res, 400, { error: "id is required" });
          return;
        }
        if (!buildBackend.installDraft) {
          sendJson(res, 501, { error: "this backend cannot install drafts" });
          return;
        }
        const result = await buildBackend.installDraft(id);
        if (result.ok) {
          // installDraft just wrote a brand-new app straight into the engine's catalog dir --
          // this process's own `apps`/`appsById` were built once at boot and have no entry for it
          // yet, so /api/apps/:id/* would 404 until something reloads. Do that now so the app is
          // visible the moment the frontend navigates to it, instead of only after a restart.
          const reload = await reloadApps();
          if (!reload.ok) {
            sendJson(res, 200, { ...result, message: `${result.message} (catalog reload pending: ${reload.reason})` });
            return;
          }
        }
        sendJson(res, result.ok ? 200 : result.status, result);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(PORT, () => {
    console.error(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
