import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { loadApps, loadCatalogApps, readSkills, type Capabilities, type LoadedApp } from "./app-loader.js";
import { createPiAgentBackend, DEFAULT_MODEL_ID } from "./backends/pi.js";
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

function appToDto(app: LoadedApp) {
  return {
    id: basename(app.dir),
    name: app.manifest.name,
    description: app.manifest.description,
    emoji: app.manifest.emoji,
    color: app.manifest.color,
  };
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
        sendJson(res, 200, { apps: apps.map(appToDto) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/apps/reload") {
        const result = await reloadApps();
        if (!result.ok) {
          sendJson(res, 409, { error: result.reason });
          return;
        }
        sendJson(res, 200, { apps: apps.map(appToDto) });
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
