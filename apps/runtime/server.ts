import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { loadApps, loadCatalogApps, type Capabilities, type LoadedApp } from "./app-loader.js";
import { createPiAgentBackend, DEFAULT_MODEL_ID } from "./backends/pi.js";
import type { AgentBackend } from "./agent-backend.js";

const APPS_DIR = new URL("..", import.meta.url).pathname;
const CATALOG_DIR = new URL("../../catalog", import.meta.url).pathname;
const MODELS_PATH = new URL("../../pi/models.json", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8787);

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function main() {
  const fileApps = loadApps(APPS_DIR);
  const catalogApps = loadCatalogApps(CATALOG_DIR);
  const apps = [...fileApps.apps, ...catalogApps.apps];
  const capabilities: Capabilities = {
    skillPaths: [...fileApps.capabilities.skillPaths, ...catalogApps.capabilities.skillPaths],
    mcpServers: [...fileApps.capabilities.mcpServers, ...catalogApps.capabilities.mcpServers],
  };
  for (const app of apps) {
    console.error(`[app] loaded ${app.manifest.name}`);
  }

  const backend: AgentBackend = await createAgentBackend(capabilities, DEFAULT_MODEL_ID);
  let streaming = false;

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
