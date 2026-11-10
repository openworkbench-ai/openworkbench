import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http.js";
import {
  createWorkspaceStore,
  projectSummary,
  sourceChanges,
  WorkspaceError,
  type WorkspaceProject,
  type WorkspaceMessage,
} from "./workspace-store.js";
import {
  applyWorkspace,
  previewWorkspace,
  readCatalogSource,
  starterFiles,
  validateWorkspace,
} from "./workspace-service.js";
import { runWorkspaceAgent } from "./workspace-agent.js";

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
  root: string;
  engineUrl: string;
  defaultModel: string;
  models: () => { id: string; name: string }[];
  catalogDirFor: (userId: string, id: string) => string | undefined;
  onApplied: (userId: string, id: string) => Promise<void>;
}) {
  const store = createWorkspaceStore(options.root);
  const busy = new Set<string>();
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
            const template = ["blank", "tracker", "research"].includes(
              body.template,
            )
              ? body.template
              : "blank";
            sendJson(
              res,
              201,
              dto(
                userId,
                store.create(userId, id, starterFiles(id, name, template)),
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
          ["validate", "apply", "preview", "chat"].includes(action)
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
            if (!options.models().some((m) => m.id === modelId))
              throw new WorkspaceError(400, "Unknown model.");
            const controller = new AbortController();
            let text = "";
            const tools: NonNullable<WorkspaceMessage["tools"]> = [];
            const pending = new Map<
              string,
              { name: string; path?: string; error?: boolean }
            >();
            const onClose = () => {
              if (!res.writableEnded) controller.abort();
            };
            store.addMessage(userId, id, {
              id: randomUUID(),
              role: "user",
              text: body.message,
              at: new Date().toISOString(),
            });
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.on("close", onClose);
            let failure: string | undefined;
            try {
              await runWorkspaceAgent({
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
                signal: controller.signal,
                onEvent(event) {
                  if (event.type === "text") text += event.delta;
                  if (event.type === "tool_start") {
                    const args = event.args as { path?: string };
                    const tool = { name: event.toolName, path: args?.path };
                    pending.set(event.toolCallId, tool);
                    tools.push(tool);
                  }
                  if (event.type === "tool_end") {
                    const tool = pending.get(event.toolCallId);
                    if (tool) tool.error = event.isError;
                  }
                  if (!res.writableEnded && !res.destroyed)
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                },
              });
              if (controller.signal.aborted)
                failure =
                  "Stopped. Any completed edits are saved in your draft.";
            } catch (error) {
              failure = (error as Error).message;
            } finally {
              store.addMessage(userId, id, {
                id: randomUUID(),
                role: "assistant",
                text:
                  text ||
                  (failure
                    ? ""
                    : "Done. Review the source changes before applying."),
                at: new Date().toISOString(),
                tools,
                error: failure,
              });
              res.off("close", onClose);
              if (!res.writableEnded && !res.destroyed) {
                if (failure)
                  res.write(
                    `data: ${JSON.stringify({ type: "error", reason: failure })}\n\n`,
                  );
                res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
                res.end();
              }
            }
            return true;
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
