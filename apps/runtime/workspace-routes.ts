import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http.js";
import {
  createWorkspaceStore,
  projectSummary,
  sourceChanges,
  WorkspaceError,
  type WorkspaceProject,
} from "./workspace-store.js";
import {
  applyWorkspace,
  previewWorkspace,
  readCatalogSource,
  starterFiles,
  validateWorkspace,
} from "./workspace-service.js";
import { runWorkspaceAgent } from "./workspace-agent.js";
import { createWorkspaceRun, type WorkspaceRun } from "./workspace-run.js";

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 5 << 20)
      throw new WorkspaceError(413, "Workspace request exceeds 5 MiB.");
    chunks.push(Buffer.from(chunk));
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new WorkspaceError(400, "Expected a JSON object.");
    return parsed;
  } catch {
    throw new WorkspaceError(400, "Request must be a valid JSON object.");
  }
}

export function createWorkspaceRoutes(options: {
  runAgent?: typeof runWorkspaceAgent;
  chatHeartbeatMs?: number;
  root: string;
  engineUrl: string;
  defaultModel: string;
  models: () => { id: string; name: string }[];
  catalogDirFor: (userId: string, id: string) => string | undefined;
  onApplied: (userId: string, id: string) => Promise<void>;
}) {
  const store = createWorkspaceStore(options.root);
  const busy = new Set<string>();
  const runs = new Map<string, WorkspaceRun>();
  const activeRuns = new Map<string, string>();
  const keyFor = (userId: string, id: string) => `${userId}:${id}`;
  function load(userId: string, id: string): WorkspaceProject {
    let p = store.get(userId, id);
    if (!p) {
      const dir = options.catalogDirFor(userId, id);
      if (!dir) throw new WorkspaceError(404, "App workspace not found.");
      p = store.create(userId, id, readCatalogSource(dir), true);
    }
    return p;
  }
  function dto(userId: string, p: WorkspaceProject) {
    return {
      ...p,
      changes: sourceChanges(p),
      busy: busy.has(keyFor(userId, p.id)),
      activeRunId: activeRuns.get(keyFor(userId, p.id)),
      agent: {
        available: !!process.env.OPENROUTER_API_KEY,
        model: options.defaultModel,
        models: options.models(),
      },
    };
  }
  return {
    store,
    summaries(userId: string) {
      return store.list(userId).map(projectSummary);
    },
    async handle(
      req: IncomingMessage,
      res: ServerResponse,
      url: URL,
      userId: string,
    ): Promise<boolean> {
      if (
        url.pathname !== "/api/workspaces" &&
        !url.pathname.startsWith("/api/workspaces/")
      )
        return false;
      try {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length === 2) {
          if (req.method === "GET") {
            sendJson(res, 200, {
              projects: store.list(userId).map(projectSummary),
            });
            return true;
          }
          if (req.method === "POST") {
            const body = await readJson(req);
            const id = `u${userId.replace(/-/g, "").slice(0, 12)}_app_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
            const name =
              typeof body.name === "string"
                ? body.name.trim().slice(0, 100)
                : "";
            sendJson(
              res,
              201,
              dto(
                userId,
                store.create(userId, id, starterFiles(id, name)),
              ),
            );
            return true;
          }
        }
        const id = parts[2];
        if (!id || parts.length > 4)
          throw new WorkspaceError(404, "Workspace route not found.");
        let p = load(userId, id);
        const action = parts[3];
        if (req.method === "GET" && !action) {
          sendJson(res, 200, dto(userId, p));
          return true;
        }
        const key = keyFor(userId, id);
        if (action === "chat" && req.method === "DELETE") {
          const body = await readJson(req);
          if (busy.has(key))
            throw new WorkspaceError(
              409,
              "Wait for the current operation to finish before clearing the chat.",
            );
          if (!Number.isInteger(body.version))
            throw new WorkspaceError(400, "A source version is required.");
          sendJson(
            res,
            200,
            dto(userId, store.clearMessages(userId, id, body.version)),
          );
          return true;
        }
        if (action === "chat" || action === "chat-stop") {
          if (req.method === "GET" && action === "chat") {
            const run = runs.get(`${key}:${url.searchParams.get("runId")}`);
            if (!run)
              throw new WorkspaceError(
                404,
                "This coding partner run is no longer available. Reload to see saved changes.",
              );
            run.attach(
              res,
              Number(url.searchParams.get("after") ?? 0),
              options.chatHeartbeatMs,
            );
            return true;
          }
          if (req.method !== "POST")
            throw new WorkspaceError(405, "Method not allowed.");
          const body = await readJson(req);
          if (
            typeof body.runId !== "string" ||
            !/^[a-zA-Z0-9-]{1,100}$/.test(body.runId)
          )
            throw new WorkspaceError(400, "A valid run ID is required.");
          const runKey = `${key}:${body.runId}`;
          const existing = runs.get(runKey);
          if (action === "chat-stop") {
            if (!existing)
              throw new WorkspaceError(404, "Coding partner run not found.");
            existing.stop();
            sendJson(res, 200, { stopped: true });
            return true;
          }
          // Idempotency also covers a lost response to the initial POST.
          if (existing) {
            existing.attach(res, 0, options.chatHeartbeatMs);
            return true;
          }
          if (busy.has(key))
            throw new WorkspaceError(
              409,
              "The app is being edited or built. Try again when it finishes.",
            );
          if (!Number.isInteger(body.version))
            throw new WorkspaceError(400, "A source version is required.");
          store.require(userId, id, body.version);
          if (!process.env.OPENROUTER_API_KEY)
            throw new WorkspaceError(
              503,
              "Set OPENROUTER_API_KEY in the server environment to connect the workspace agent.",
            );
          if (
            typeof body.message !== "string" ||
            !body.message.trim() ||
            body.message.length > 32000
          )
            throw new WorkspaceError(
              400,
              "Provide a message of at most 32,000 characters.",
            );
          const modelId =
            typeof body.modelId === "string"
              ? body.modelId
              : options.defaultModel;
          if (!options.models().some((model) => model.id === modelId))
            throw new WorkspaceError(400, "Unknown model.");
          busy.add(key);
          try {
            const run = createWorkspaceRun({
              store,
              userId,
              id,
              engineUrl: options.engineUrl,
              message: body.message,
              selectedFile:
                typeof body.selectedFile === "string"
                  ? body.selectedFile
                  : undefined,
              modelId,
              runAgent: options.runAgent,
              onFinished() {
                busy.delete(key);
                activeRuns.delete(key);
                const expiry = setTimeout(
                  () => runs.delete(runKey),
                  10 * 60 * 1000,
                );
                expiry.unref();
              },
            });
            runs.set(runKey, run);
            activeRuns.set(key, body.runId);
            run.attach(res, 0, options.chatHeartbeatMs);
          } catch (error) {
            busy.delete(key);
            throw error;
          }
          return true;
        }
        if (busy.has(key))
          throw new WorkspaceError(
            409,
            "This app is being edited or built. Wait for the current operation to finish.",
          );
        if (req.method === "PATCH" && !action) {
          const body = await readJson(req);
          if (busy.has(key))
            throw new WorkspaceError(
              409,
              "The app is being edited or built. Try again when it finishes.",
            );
          if (!Number.isInteger(body.version))
            throw new WorkspaceError(400, "A source version is required.");
          sendJson(
            res,
            200,
            dto(userId, store.update(userId, id, body.version, body.files)),
          );
          return true;
        }
        if (req.method === "POST" && action === "restore") {
          const body = await readJson(req);
          if (busy.has(key))
            throw new WorkspaceError(
              409,
              "The app is being edited or built. Try again when it finishes.",
            );
          if (!Number.isInteger(body.version))
            throw new WorkspaceError(400, "A source version is required.");
          if (
            body.revisionId !== undefined &&
            typeof body.revisionId !== "string"
          )
            throw new WorkspaceError(400, "Invalid revision.");
          sendJson(
            res,
            200,
            dto(
              userId,
              store.restore(userId, id, body.version, body.revisionId),
            ),
          );
          return true;
        }
        if (
          req.method === "POST" &&
          ["validate", "apply", "preview"].includes(action)
        ) {
          const body = await readJson(req);
          if (busy.has(key))
            throw new WorkspaceError(
              409,
              "The app is being edited or built. Try again when it finishes.",
            );
          if (!Number.isInteger(body.version))
            throw new WorkspaceError(400, "A source version is required.");
          p = store.require(userId, id, body.version);
          busy.add(key);
          try {
            if (action === "validate") {
              sendJson(res, 200, await validateWorkspace(p, options.engineUrl));
              return true;
            }
            if (action === "preview") {
              sendJson(res, 200, {
                html: await previewWorkspace(p, String(body.component ?? "")),
                version: p.version,
              });
              return true;
            }
            if (action === "apply") {
              const validation = await validateWorkspace(p, options.engineUrl);
              if (!validation.valid) {
                sendJson(res, 422, {
                  error: "Fix validation problems before applying.",
                  ...validation,
                });
                return true;
              }
              await applyWorkspace(p, options.engineUrl, body.confirm === true);
              const applied = store.applied(
                userId,
                id,
                p.version,
                typeof body.message === "string"
                  ? body.message
                  : p.installed
                    ? "Updated app"
                    : "First release",
              );
              await options.onApplied(userId, id);
              busy.delete(key);
              sendJson(res, 200, dto(userId, applied));
              return true;
            }
          } finally {
            busy.delete(key);
          }
        }
        throw new WorkspaceError(404, "Workspace route not found.");
      } catch (error) {
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return true;
        }
        sendJson(res, error instanceof WorkspaceError ? error.status : 500, {
          error: (error as Error).message,
        });
        return true;
      }
    },
  };
}
