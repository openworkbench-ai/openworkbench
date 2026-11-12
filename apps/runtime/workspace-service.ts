import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildAppUi, readAppBundle } from "./build-tools.js";
import { buildAppUI } from "@openworkbench/app-ui-kit/build";
import { buildPythonPackages } from "./python-packages.js";
import {
  assertFiles,
  validSourcePath,
  WorkspaceError,
  type SourceFiles,
  type WorkspaceProject,
} from "./workspace-store.js";
import { inspectComponentSource } from "./workspace-source.js";

const run = promisify(execFile);
export interface WorkspaceProblem {
  path: string;
  message: string;
  line?: number;
}
export interface WorkspaceValidation {
  valid: boolean;
  version: number;
  problems: WorkspaceProblem[];
  migration?: { kind: string; description: string; destructive: boolean }[];
  permissions?: { network: string[]; model: boolean; data: string[] };
  requiresConfirmation?: boolean;
}

export function readCatalogSource(dir: string): SourceFiles {
  const files: SourceFiles = {};
  function walk(folder: string, prefix = "") {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (
        (entry.isDirectory() &&
          ["skills", "ui", "ui/components", "functions", "data"].some(
            (p) => p === path || p.startsWith(`${path}/`),
          )) ||
        (entry.isDirectory() && /^skills\/[a-z][a-z0-9_-]*$/.test(path))
      ) {
        walk(join(folder, entry.name), path);
      } else if (entry.isFile() && validSourcePath(path)) {
        if (lstatSync(join(folder, entry.name)).size > 1 << 20)
          throw new WorkspaceError(400, `Source file too large: ${path}`);
        files[path] = readFileSync(join(folder, entry.name), "utf8");
      }
    }
  }
  walk(dir);
  assertFiles(files);
  return files;
}

/** Only immutable source snapshots reach build tools. Clients never choose a filesystem path. */
export async function withWorkspaceSnapshot<T>(
  p: WorkspaceProject,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  assertFiles(p.files);
  const root = mkdtempSync(join(tmpdir(), "owb-workspace-"));
  try {
    symlinkSync(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      join(root, "node_modules"),
    );
    for (const [path, content] of Object.entries(p.files)) {
      const target = join(root, p.id, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function validateWorkspace(
  p: WorkspaceProject,
  engineUrl: string,
  build = true,
): Promise<WorkspaceValidation> {
  const problems: WorkspaceProblem[] = [];
  const result: WorkspaceValidation = {
    valid: false,
    version: p.version,
    problems,
  };
  let manifest: any;
  try {
    manifest = JSON.parse(p.files["manifest.json"]);
  } catch (error) {
    problems.push({
      path: "manifest.json",
      message: `Invalid JSON: ${(error as Error).message}`,
    });
    return result;
  }
  if (manifest?.app?.id !== p.id)
    problems.push({
      path: "manifest.json",
      message: `App identity is fixed. Keep app.id as "${p.id}".`,
    });
  const response = await fetch(`${engineUrl}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: p.files["manifest.json"],
  });
  const validation = (await response.json()) as {
    valid?: boolean;
    errors?: { path: string; message: string }[];
  };
  for (const err of validation.errors ?? [])
    problems.push({
      path: "manifest.json",
      message: `${err.path || "manifest"}: ${err.message}`,
    });
  if (!validation.valid) return result;
  problems.push(...inspectComponentSource(p.files));
  for (const [path, content] of Object.entries(p.files)) {
    if (path.endsWith("SKILL.md")) {
      const frontmatter =
        /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? "";
      if (
        !/^name:\s*\S[^\r\n]*$/m.test(frontmatter) ||
        !/^description:\s*\S[^\r\n]*$/m.test(frontmatter)
      )
        problems.push({
          path,
          message:
            "A skill needs YAML frontmatter with name and description, followed by its instructions.",
        });
    }
    if (path.startsWith("data/")) {
      try {
        if (!Array.isArray(JSON.parse(content)))
          throw new Error("Expected an array of seed rows.");
      } catch (error) {
        problems.push({ path, message: (error as Error).message });
      }
    }
  }
  if (problems.length) return result;
  await withWorkspaceSnapshot(p, async (root) => {
    const bundle = readAppBundle(root, p.id);
    if ("error" in bundle) {
      problems.push({ path: "manifest.json", message: bundle.error });
      return;
    }
    for (const [path] of Object.entries(p.files).filter(([path]) =>
      path.endsWith(".py"),
    )) {
      try {
        await run(
          process.env.PYTHON ?? "python3",
          [
            "-c",
            "import ast,sys; ast.parse(open(sys.argv[1]).read(), filename=sys.argv[1])",
            join(root, p.id, path),
          ],
          { timeout: 10000 },
        );
      } catch (error) {
        problems.push({
          path,
          message:
            (error as { stderr?: string }).stderr?.replaceAll(
              root + "/" + p.id + "/",
              "",
            ) || (error as Error).message,
        });
      }
    }
    const packages = await buildPythonPackages(join(root, p.id));
    if ("error" in packages)
      problems.push({ path: "manifest.json", message: packages.error });
    if (build && !problems.length) {
      const ui = await buildAppUi(root, p.id);
      if ("error" in ui)
        problems.push({
          path: "ui/components",
          message: ui.error.replaceAll(root + "/" + p.id + "/", ""),
        });
      else {
        for (const tool of manifest.tools ?? [])
          if (
            tool.ui?.component &&
            !ui.components.some((c) => c.name === tool.ui.component)
          )
            problems.push({
              path: "manifest.json",
              message: `Tool ${tool.name} needs ui/components/${tool.ui.component}.tsx.`,
            });
      }
    }
  });
  if (!problems.length) {
    const preview = await fetch(`${engineUrl}/admin/apps/${p.id}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: p.files["manifest.json"],
    });
    const body = (await preview.json()) as any;
    if (!preview.ok)
      problems.push({
        path: "manifest.json",
        message: body.error?.message ?? "Unable to inspect the running app.",
      });
    else {
      result.migration = body.migration;
      result.permissions = body.permissions;
      result.requiresConfirmation = body.requiresConfirmation;
    }
  }
  result.valid = problems.length === 0;
  return result;
}

export async function applyWorkspace(
  p: WorkspaceProject,
  engineUrl: string,
  confirm: boolean,
) {
  return withWorkspaceSnapshot(p, async (root) => {
    const bundle = readAppBundle(root, p.id);
    if ("error" in bundle) throw new WorkspaceError(422, bundle.error);
    const ui = await buildAppUi(root, p.id);
    if ("error" in ui) throw new WorkspaceError(422, ui.error);
    const packages = await buildPythonPackages(join(root, p.id));
    if ("error" in packages) throw new WorkspaceError(422, packages.error);
    const response = await fetch(`${engineUrl}/admin/apps/${p.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: JSON.parse(bundle.manifestRaw),
        skills: bundle.skills,
        data: bundle.data,
        ui: ui.components,
        functionFiles: bundle.functionFiles,
        pythonWheels: packages.wheels,
        sourceFiles: Object.entries(p.files)
          .filter(
            ([path]) =>
              path.startsWith("ui/components/") ||
              path.startsWith("functions/"),
          )
          .map(([path, content]) => ({ path, content })),
        confirm,
      }),
    });
    const body = (await response.json()) as any;
    if (!response.ok)
      throw new WorkspaceError(
        response.status,
        body.error?.message ?? JSON.stringify(body),
      );
    return body;
  });
}

export async function previewWorkspace(p: WorkspaceProject, component: string) {
  if (
    !/^[A-Za-z][A-Za-z0-9]*$/.test(component) ||
    !p.files[`ui/components/${component}.tsx`]
  )
    throw new WorkspaceError(404, "Component not found.");
  const problems = inspectComponentSource(p.files);
  if (problems.length)
    throw new WorkspaceError(
      422,
      problems.map((p) => `${p.path}: ${p.message}`).join("\n"),
    );
  // Type-check all source before compiling the isolated preview.
  return withWorkspaceSnapshot(p, async (root) => {
    const ui = await buildAppUi(root, p.id);
    if ("error" in ui) throw new WorkspaceError(422, ui.error);
    const manifest = JSON.parse(p.files["manifest.json"]);
    const built = await buildAppUI({
      appDir: join(root, p.id),
      accentColor: manifest.app?.color,
      preview: true,
      component,
    });
    const html = built[0]?.html;
    if (!html)
      throw new WorkspaceError(422, "Preview build produced no component.");
    return html.replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`,
    );
  });
}

export function starterFiles(id: string, name: string): SourceFiles {
  const manifest = {
    app: {
      id,
      name: name || "Untitled app",
      description: "A little space for your next big idea.",
      emoji: "✳️",
      color: "#61754e",
      version: 1,
    },
    entities: [],
    tools: [],
  };
  return { "manifest.json": JSON.stringify(manifest, null, 2) + "\n" };
}
