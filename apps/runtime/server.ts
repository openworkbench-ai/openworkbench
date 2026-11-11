import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadApps, loadCatalogApps, readSkills, type Capabilities, type LoadedApp, type McpServerConfig } from "./app-loader.js";
import { createPiAgentBackend, DEFAULT_MODEL_ID } from "./backends/pi.js";
import { createBuildAgentBackend } from "./backends/build-agent.js";
import { resolveHeaders } from "./mcp-tools.js";
import type { AgentBackend } from "./agent-backend.js";
import type { AuthProvider } from "./auth-provider.js";
import { sendJson } from "./http.js";
import { createOwnershipStore } from "./ownership-store.js";
import { createPasswordProvider } from "./password-provider.js";
import { createUserStore } from "./user-store.js";
import { createUserRuntimes } from "./user-runtime.js";
import { createWorkspaceRoutes } from "./workspace-routes.js";

const APPS_DIR = new URL("..", import.meta.url).pathname;
const CATALOG_DIR = new URL("../../catalog", import.meta.url).pathname;
const MODELS_PATH = new URL("../../pi/models.json", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8787);
const ENGINE_URL = process.env.ENGINE_URL ?? "http://127.0.0.1:8080";
const AUTH_DB_PATH = process.env.AUTH_DB_PATH ?? new URL("../../data/auth.db", import.meta.url).pathname;
// Which app belongs to which user. Kept apart from the accounts file so it outlives the built-in auth provider.
const OWNERSHIP_DB_PATH = process.env.OWNERSHIP_DB_PATH ?? join(dirname(AUTH_DB_PATH), "ownership.db");
// The first account can always be created; further sign-ups need this opt-in, so a
// self-hosted instance exposed to the internet doesn't hand out model spend to strangers.
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP === "true";

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

/** Engine-side id for an app a user builds: namespaced by user so two users' drafts named "tracker" can't collide. */
function installIdFor(userId: string, draftId: string): string {
  return `u${userId.replace(/-/g, "").slice(0, 12)}_${draftId}`;
}

/** Narrows the process-wide capabilities to the apps one user can see (their own catalog apps plus any shared file-based apps). */
function capabilitiesFor(all: Capabilities, visibleIds: Set<string>): Capabilities {
  return {
    skillPaths: all.skillPaths.filter((p) => visibleIds.has(basename(dirname(p)))),
    mcpServers: all.mcpServers.filter((s) => visibleIds.has(s.name)),
  };
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
  // The one place an auth provider is chosen. To use a hosted provider (Clerk, WorkOS, OIDC...),
  // construct an AuthProvider for it here instead -- nothing below knows how people sign in.
  const auth: AuthProvider = createPasswordProvider(createUserStore(AUTH_DB_PATH), { allowSignup: ALLOW_SIGNUP });
  const ownership = createOwnershipStore(OWNERSHIP_DB_PATH);

  let { apps, appsById, capabilities } = loadCatalog();
  for (const app of apps) {
    console.error(`[app] loaded ${app.manifest.name}`);
  }

  /** Apps a user may see and use: shared file-based apps plus the catalog apps they own. */
  function visibleAppIds(userId: string): Set<string> {
    const owned = ownership.appsOwnedBy(userId);
    return new Set(apps.filter((app) => !app.engine || owned.has(basename(app.dir))).map((app) => basename(app.dir)));
  }

  /** Looks up an app by id, but only if `userId` may see it -- someone else's app is indistinguishable from a missing one. */
  function appFor(userId: string, id: string): LoadedApp | undefined {
    const app = appsById.get(id);
    return app && visibleAppIds(userId).has(id) ? app : undefined;
  }

  function appListFor(userId: string, statuses: Map<string, string>) {
    const visible = visibleAppIds(userId);
    return apps.filter((app) => visible.has(basename(app.dir))).map((app) => appToDto(app, statuses));
  }

  // Every user gets their own chat agent (over just their apps) and their own build
  // agent + scratch workspace, created on first use -- no conversation, model choice,
  // or half-built draft is shared between accounts.
  const runtimes = createUserRuntimes({
    createChat: (caps, modelId) => createAgentBackend(caps, modelId ?? DEFAULT_MODEL_ID),
    createBuild: (modelId) => createBuildAgentBackend(ENGINE_URL, modelId ?? DEFAULT_MODEL_ID),
    capabilitiesFor: (userId) => capabilitiesFor(capabilities, visibleAppIds(userId)),
  });
  const pendingChatRefresh = new Set<string>();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await runtimes.disposeAll();
      process.exit(0);
    });
  }

  /** Re-scans app.json/manifest.json from disk, then rebuilds this user's chat agent so it sees their current apps. Other users' agents are unaffected: they can't see this user's apps. */
  async function reloadApps(userId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const next = loadCatalog();
    apps = next.apps;
    appsById = next.appsById;
    capabilities = next.capabilities;
    for (const app of apps) {
      console.error(`[app] loaded ${app.manifest.name}`);
    }
    // Refused while a response is streaming rather than queued: recreating the backend mid-response
    // would pull the rug out from under an in-flight tool call, and history lives inside the
    // one Pi session being replaced, so a refresh starts a fresh conversation.
    if (!(await runtimes.forUser(userId).refreshChat())) {
      pendingChatRefresh.add(userId);
      return { ok: false, reason: "the agent is still responding to a previous message" };
    }
    pendingChatRefresh.delete(userId);
    return { ok: true };
  }

  const workspaces = createWorkspaceRoutes({
    root: process.env.WORKSPACES_DIR ?? join(dirname(AUTH_DB_PATH), "workspaces"),
    engineUrl: ENGINE_URL,
    defaultModel: DEFAULT_MODEL_ID,
    models: loadCuratedModels,
    catalogDirFor(userId, id) { const app = appFor(userId, id); return app?.engine ? app.dir : undefined; },
    async onApplied(userId, id) { ownership.claim(id, userId); await reloadApps(userId); },
  });

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
      if (url.pathname === "/api/auth/status" && req.method === "GET") {
        const identity = await auth.authenticate(req);
        sendJson(res, 200, {
          authenticated: identity != null,
          user: identity ?? undefined,
          signIn: auth.signIn(),
        });
        return;
      }

      if (url.pathname.startsWith("/api/auth/") && (await auth.handleRoute?.(req, res, url))) return;

      const user = await auth.authenticate(req);
      if (!user) {
        sendJson(res, 401, { error: "Authentication required." });
        return;
      }
      // Apps from before ownership existed go to whoever signs in first on this instance (once, ever).
      ownership.claimExistingOnce(user.id, apps.filter((app) => app.engine).map((app) => basename(app.dir)));
      const runtime = runtimes.forUser(user.id);

      if (await workspaces.handle(req, res, url, user.id)) return;

      if (req.method === "GET" && url.pathname === "/api/apps") {
        const running = appListFor(user.id, await fetchAdminStatuses());
        const projects = workspaces.summaries(user.id);
        sendJson(res, 200, { apps: [
          ...running.map(app => ({ ...app, installed: true, changes: projects.find(p => p.id === app.id)?.changes ?? 0 })),
          ...projects.filter(p => !running.some(app => app.id === p.id)).map(p => ({ ...p, manageable: false, status: "draft" })),
        ] });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/apps/reload") {
        const result = await reloadApps(user.id);
        if (!result.ok) {
          sendJson(res, 409, { error: result.reason });
          return;
        }
        sendJson(res, 200, { apps: appListFor(user.id, await fetchAdminStatuses()) });
        return;
      }

      const toggleMatch = req.method === "POST" ? matchToggleRoute(url.pathname) : null;
      if (toggleMatch) {
        const app = appFor(user.id, toggleMatch.id);
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
        const app = appFor(user.id, appSegments.id);
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
        // Catalog apps are per-user: an MCP server named after an app someone else owns is off limits.
        const ownedByOther = appsById.has(mcpProxyMatch.id) && !appFor(user.id, mcpProxyMatch.id);
        if (!mcpServer || ownedByOther) {
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
        sendJson(res, 200, { models: loadCuratedModels(), current: (await runtime.chat()).getModelId() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/model") {
        const { modelId } = JSON.parse(await readBody(req));
        if (typeof modelId !== "string" || !modelId) {
          sendJson(res, 400, { error: "modelId is required" });
          return;
        }
        const backend = await runtime.chat();
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
        if (runtime.streaming) {
          sendJson(res, 409, { error: "the agent is still responding to a previous message" });
          return;
        }

        const backend = await runtime.chat();
        runtime.streaming = true;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        // A dropped connection (reload, navigation, tab close) never calls
        // stop()/clearChat() -- without this, backend.prompt() keeps running
        // unattended and `streaming` never resets, wedging every later message
        // behind a 409 forever (see build-chat below for the same bug).
        const onClientGone = () => {
          if (!res.writableEnded) backend.abort?.().catch(() => {});
        };
        res.on("close", onClientGone);

        try {
          await backend.prompt(message, (event) => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
          });
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: "error", reason })}\n\n`);
        } finally {
          res.off("close", onClientGone);
          runtime.streaming = false;
          if (!res.writableEnded) res.end();
          if (pendingChatRefresh.delete(user.id)) {
            try { await runtime.refreshChat(); }
            catch (error) { console.error("[agent] deferred app refresh failed:", error instanceof Error ? error.message : String(error)); }
          }
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/build-chat/models") {
        sendJson(res, 200, { models: loadCuratedModels(), current: (await runtime.build()).getModelId() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/build-chat/model") {
        const { modelId } = JSON.parse(await readBody(req));
        if (typeof modelId !== "string" || !modelId) {
          sendJson(res, 400, { error: "modelId is required" });
          return;
        }
        const buildBackend = await runtime.build();
        await buildBackend.setModel(modelId);
        sendJson(res, 200, { current: buildBackend.getModelId() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/build-chat") {
        const { message } = JSON.parse(await readBody(req));
        if (typeof message !== "string" || !message.trim()) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }
        if (runtime.buildStreaming) {
          sendJson(res, 409, { error: "the build agent is still responding to a previous message" });
          return;
        }

        const buildBackend = await runtime.build();
        runtime.buildStreaming = true;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        // Same fix as /api/chat above -- and doubly necessary here, since a
        // pending ask_questions call blocks this same prompt() call, so a
        // dropped connection before the user answers would otherwise wedge
        // buildStreaming forever with no way to recover short of a restart.
        const onClientGone = () => {
          if (!res.writableEnded) buildBackend.abort?.().catch(() => {});
        };
        res.on("close", onClientGone);

        try {
          await buildBackend.prompt(message, (event) => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
          });
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: "error", reason })}\n\n`);
        } finally {
          res.off("close", onClientGone);
          runtime.buildStreaming = false;
          if (!res.writableEnded) res.end();
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/build-chat/answer") {
        const { toolCallId, answers } = JSON.parse(await readBody(req));
        if (typeof toolCallId !== "string" || !toolCallId || !Array.isArray(answers)) {
          sendJson(res, 400, { error: "toolCallId and answers are required" });
          return;
        }
        const resolved = (await runtime.build()).respondToTool?.(toolCallId, answers) ?? false;
        if (!resolved) {
          sendJson(res, 404, { error: `no pending question with toolCallId "${toolCallId}"` });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/build-chat/draft/")) {
        const id = url.pathname.slice("/api/build-chat/draft/".length);
        const draft = id ? (await runtime.build()).readDraft?.(id) ?? null : null;
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
        const buildBackend = await runtime.build();
        if (!buildBackend.installDraft) {
          sendJson(res, 501, { error: "this backend cannot install drafts" });
          return;
        }
        // Installed under a per-user id, and recorded as theirs so no one else can see or open it.
        const installId = installIdFor(user.id, id);
        const result = await buildBackend.installDraft(id, installId);
        if (result.ok) {
          ownership.claim(installId, user.id);
          // installDraft just wrote a brand-new app straight into the engine's catalog dir --
          // this process's own `apps`/`appsById` were built once at boot and have no entry for it
          // yet, so /api/apps/:id/* would 404 until something reloads. Do that now so the app is
          // visible the moment the frontend navigates to it, instead of only after a restart.
          const reload = await reloadApps(user.id);
          if (!reload.ok) {
            sendJson(res, 200, { ...result, appId: installId, message: `${result.message} (catalog reload pending: ${reload.reason})` });
            return;
          }
        }
        // `appId` is the id the app now lives under (namespaced per user), which the UI must navigate to.
        sendJson(res, result.ok ? 200 : result.status, result.ok ? { ...result, appId: installId } : result);
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
