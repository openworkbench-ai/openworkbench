import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type SourceFiles = Record<string, string>;
import type { WorkspaceMessage } from "../../packages/workspace-chat.js";
export type { WorkspaceMessage } from "../../packages/workspace-chat.js";
export interface WorkspaceRevision {
  id: string;
  number: number;
  at: string;
  message: string;
  files: SourceFiles;
}
export interface WorkspaceProject {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  installed: boolean;
  files: SourceFiles;
  baseFiles: SourceFiles;
  revisions: WorkspaceRevision[];
  messages: WorkspaceMessage[];
  authors: Record<string, "you" | "agent">;
}

export class WorkspaceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function validAppId(id: string): boolean {
  return /^[a-z][a-z0-9_]{0,100}$/.test(id);
}

/** A closed source contract. Generated output, dependencies and arbitrary host files are never editable. */
export function validSourcePath(path: string): boolean {
  return (
    path === "manifest.json" ||
    /^skills\/[a-z][a-z0-9_-]*\/SKILL\.md$/.test(path) ||
    /^ui\/components\/[A-Za-z][A-Za-z0-9_]*\.(tsx|ts)$/.test(path) ||
    /^functions\/[a-zA-Z][a-zA-Z0-9_]*\.py$/.test(path) ||
    /^data\/[a-z][a-z0-9_]*\.json$/.test(path)
  );
}

export function assertFiles(files: SourceFiles) {
  if (!files || typeof files !== "object" || Array.isArray(files))
    throw new WorkspaceError(400, "Expected source files.");
  const paths = Object.keys(files);
  if (paths.length > 256)
    throw new WorkspaceError(
      400,
      "An app can contain at most 256 source files.",
    );
  let size = 0;
  for (const path of paths) {
    if (!validSourcePath(path))
      throw new WorkspaceError(400, `Unsupported app file: ${path}`);
    if (typeof files[path] !== "string")
      throw new WorkspaceError(400, "Source file content must be text.");
    const bytes = Buffer.byteLength(files[path]);
    if (bytes > 1 << 20)
      throw new WorkspaceError(400, `${path} exceeds the 1 MiB file limit.`);
    size += bytes;
  }
  if (size > 4 << 20)
    throw new WorkspaceError(400, "App source exceeds the 4 MiB limit.");
  if (!("manifest.json" in files))
    throw new WorkspaceError(400, "An app must have a manifest.json.");
}

export function sourceChanges(
  project: Pick<WorkspaceProject, "files" | "baseFiles" | "authors">,
) {
  return [
    ...new Set([
      ...Object.keys(project.files),
      ...Object.keys(project.baseFiles),
    ]),
  ]
    .sort()
    .filter((path) => project.files[path] !== project.baseFiles[path])
    .map((path) => ({
      path,
      kind: !(path in project.baseFiles)
        ? "added"
        : !(path in project.files)
          ? "deleted"
          : "modified",
      author: project.authors[path] ?? "you",
    }));
}

export function projectSummary(p: WorkspaceProject) {
  let app: Record<string, unknown> = {};
  try {
    app = JSON.parse(p.files["manifest.json"]).app ?? {};
  } catch {
    /* Invalid source is a valid saved draft. */
  }
  return {
    id: p.id,
    name: typeof app.name === "string" ? app.name : "Untitled app",
    description: typeof app.description === "string" ? app.description : "",
    emoji: app.emoji,
    color: app.color,
    installed: p.installed,
    updatedAt: p.updatedAt,
    changes: sourceChanges(p).length,
  };
}

export function createWorkspaceStore(root: string) {
  function userDir(userId: string) {
    return join(root, createHash("sha256").update(userId).digest("hex"));
  }
  function file(userId: string, id: string) {
    if (!validAppId(id)) throw new WorkspaceError(400, "Invalid app id.");
    return join(userDir(userId), `${id}.json`);
  }
  function save(userId: string, project: WorkspaceProject) {
    assertFiles(project.files);
    mkdirSync(userDir(userId), { recursive: true, mode: 0o700 });
    const target = file(userId, project.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(project), { mode: 0o600 });
    renameSync(temporary, target);
    return structuredClone(project);
  }
  function get(userId: string, id: string): WorkspaceProject | null {
    const path = file(userId, id);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  }
  function requireProject(userId: string, id: string, version?: number) {
    const p = get(userId, id);
    if (!p) throw new WorkspaceError(404, "App workspace not found.");
    if (version !== undefined && version !== p.version)
      throw new WorkspaceError(
        409,
        "This draft changed in another tab. Reload the workspace before saving.",
      );
    return p;
  }
  function create(
    userId: string,
    id: string,
    files: SourceFiles,
    installed = false,
  ) {
    if (get(userId, id))
      throw new WorkspaceError(409, "This app workspace already exists.");
    assertFiles(files);
    const at = new Date().toISOString();
    return save(userId, {
      id,
      version: 1,
      createdAt: at,
      updatedAt: at,
      installed,
      files,
      baseFiles: installed ? { ...files } : {},
      authors: {},
      revisions: installed
        ? [
            {
              id: randomUUID(),
              number: 1,
              at,
              message: "Imported running app",
              files: { ...files },
            },
          ]
        : [],
      messages: [],
    });
  }
  function update(
    userId: string,
    id: string,
    version: number,
    patch: Record<string, string | null>,
    author: "you" | "agent" = "you",
  ) {
    const p = requireProject(userId, id, version);
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      throw new WorkspaceError(400, "Expected file changes.");
    for (const [path, content] of Object.entries(patch)) {
      if (!validSourcePath(path))
        throw new WorkspaceError(400, `Unsupported app file: ${path}`);
      if (content !== null && typeof content !== "string")
        throw new WorkspaceError(400, "Source file content must be text.");
      if (path === "manifest.json" && content === null)
        throw new WorkspaceError(400, "The app manifest cannot be deleted.");
      if (content === null) delete p.files[path];
      else p.files[path] = content;
      p.authors[path] = author;
    }
    assertFiles(p.files);
    p.version++;
    p.updatedAt = new Date().toISOString();
    return save(userId, p);
  }
  return {
    get,
    create,
    update,
    require: requireProject,
    list(userId: string) {
      const dir = userDir(userId);
      return existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => get(userId, f.slice(0, -5))!)
            .filter(Boolean)
        : [];
    },
    restore(userId: string, id: string, version: number, revisionId?: string) {
      const p = requireProject(userId, id, version);
      const files = revisionId
        ? p.revisions.find((r) => r.id === revisionId)?.files
        : p.baseFiles;
      if (!files || !("manifest.json" in files))
        throw new WorkspaceError(400, "There is no saved revision to restore.");
      return update(
        userId,
        id,
        version,
        Object.fromEntries(
          [...new Set([...Object.keys(p.files), ...Object.keys(files)])].map(
            (path) => [path, files[path] ?? null],
          ),
        ),
      );
    },
    applied(userId: string, id: string, version: number, message: string) {
      const p = requireProject(userId, id, version);
      p.baseFiles = { ...p.files };
      p.installed = true;
      p.revisions.push({
        id: randomUUID(),
        number: (p.revisions.at(-1)?.number ?? 0) + 1,
        at: new Date().toISOString(),
        message: message.slice(0, 300) || "Updated app",
        files: { ...p.files },
      });
      // A bounded history of source snapshots, never database snapshots.
      p.revisions = p.revisions.slice(-20);
      p.authors = {};
      p.version++;
      p.updatedAt = new Date().toISOString();
      return save(userId, p);
    },
    clearMessages(userId: string, id: string, version: number) {
      const p = requireProject(userId, id, version);
      p.messages = [];
      return save(userId, p);
    },
    addMessage(userId: string, id: string, message: WorkspaceMessage) {
      const p = requireProject(userId, id);
      p.messages.push(message);
      p.messages = p.messages.slice(-100);
      // Transcript updates don't conflict with source version checks.
      return save(userId, p);
    },
  };
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
