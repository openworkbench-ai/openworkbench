import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AppManifest {
  name: string;
  description: string;
  emoji?: string;
  color?: string;
}

export interface EngineEntityField {
  id: string;
  name: string;
  type: string;
  required?: boolean;
  target?: string;
  values?: string[];
}

export interface EngineEntity {
  id: string;
  name: string;
  fields: EngineEntityField[];
}

export interface EngineToolParam {
  id: string;
  name: string;
  type: string;
  required?: boolean;
}

export interface EngineTool {
  id: string;
  name: string;
  description?: string;
  params?: EngineToolParam[];
  /** Set when this tool's result renders via ui/components/<component>.tsx. */
  ui?: { component: string };
}

export interface LoadedApp {
  manifest: AppManifest;
  dir: string;
  /** Present only for catalog (engine-backed) apps — the raw manifest tools/entities. */
  engine?: { entities: EngineEntity[]; tools: EngineTool[] };
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  content: string;
}

export interface McpServerConfig {
  name: string;
  url: string;
  /**
   * HTTP headers sent to the MCP endpoint (e.g. for auth). A value written as
   * "${ENV_VAR}" is resolved from the environment at load time instead of
   * being stored in the file, so secrets don't need to live in mcp.json.
   */
  headers?: Record<string, string>;
}

/** On-disk shape of apps/<app>/mcp.json — the same `mcpServers` map convention used by Claude/Cursor's .mcp.json. */
interface McpConfigFile {
  mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
}

export interface Capabilities {
  skillPaths: string[];
  mcpServers: McpServerConfig[];
}

export interface LoadAppsResult {
  apps: LoadedApp[];
  capabilities: Capabilities;
}

const DEFAULT_ENGINE_URL = "http://127.0.0.1:8080";

/** Shape of catalog/<app>/manifest.json — the pocketknife engine's schema-driven app manifest. */
interface EngineManifest {
  app: { id: string; name: string; description?: string; emoji?: string; color?: string };
  entities?: EngineEntity[];
  tools?: EngineTool[];
}

/**
 * Scans `appsDir` for installed apps (one subdirectory per app, each with an
 * `app.json` manifest) and aggregates the capabilities they contribute:
 * a `skills/` directory of SKILL.md-based skills, and/or an `mcp.json` list
 * of remote MCP servers to connect to. More capability types can be added
 * the same way later.
 */
export function loadApps(appsDir: string): LoadAppsResult {
  const apps: LoadedApp[] = [];
  const skillPaths: string[] = [];
  const mcpServers: McpServerConfig[] = [];

  if (!existsSync(appsDir)) {
    return { apps, capabilities: { skillPaths, mcpServers } };
  }

  for (const entry of readdirSync(appsDir)) {
    const appDir = join(appsDir, entry);
    if (!statSync(appDir).isDirectory()) continue;

    const manifestPath = join(appDir, "app.json");
    if (!existsSync(manifestPath)) continue;

    const manifest: AppManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    apps.push({ manifest, dir: appDir });

    const skillsDir = join(appDir, "skills");
    if (existsSync(skillsDir)) {
      skillPaths.push(skillsDir);
    }

    const mcpConfigPath = join(appDir, "mcp.json");
    if (existsSync(mcpConfigPath)) {
      const config: McpConfigFile = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
      for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
        mcpServers.push({ name, url: server.url, headers: server.headers });
      }
    }
  }

  return { apps, capabilities: { skillPaths, mcpServers } };
}

/** Splits a SKILL.md file into its flat `name`/`description` frontmatter and markdown body. */
function parseSkillFile(path: string): { name: string; description: string; content: string } {
  const raw = readFileSync(path, "utf-8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) return { name: "", description: "", content: raw };

  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    fields[key] = value;
  }

  return { name: fields.name ?? "", description: fields.description ?? "", content: body.trim() };
}

/** Reads every `<appDir>/skills/<skill>/SKILL.md`, parsed for display in the app viewer. */
export function readSkills(appDir: string): SkillInfo[] {
  const skillsDir = join(appDir, "skills");
  if (!existsSync(skillsDir)) return [];

  const skills: SkillInfo[] = [];
  for (const entry of readdirSync(skillsDir)) {
    const skillDir = join(skillsDir, entry);
    if (!statSync(skillDir).isDirectory()) continue;

    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const { name, description, content } = parseSkillFile(skillFile);
    skills.push({ id: entry, name: name || entry, description, content });
  }

  return skills;
}

/**
 * Scans `catalogDir` for engine-managed apps (one subdirectory per app, each
 * with a `manifest.json` in the pocketknife engine's schema) and aggregates
 * the same kind of capabilities as `loadApps`: skills from a `skills/`
 * directory, and an MCP server pointing at the engine's per-app endpoint
 * (`/mcp/<app_id>`) when the manifest declares any tools — the engine
 * exposes every manifest-declared tool as one MCP tool there. If the engine
 * isn't running, the connection just fails gracefully at query time (see
 * mcp-tools.ts); nothing here talks to the engine directly.
 */
export function loadCatalogApps(catalogDir: string, engineUrl: string = process.env.ENGINE_URL ?? DEFAULT_ENGINE_URL): LoadAppsResult {
  const apps: LoadedApp[] = [];
  const skillPaths: string[] = [];
  const mcpServers: McpServerConfig[] = [];

  if (!existsSync(catalogDir)) {
    return { apps, capabilities: { skillPaths, mcpServers } };
  }

  for (const entry of readdirSync(catalogDir)) {
    const appDir = join(catalogDir, entry);
    if (!statSync(appDir).isDirectory()) continue;

    const manifestPath = join(appDir, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    const engineManifest: EngineManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const tools = engineManifest.tools ?? [];

    // Falls back to a generated summary for apps that haven't set a description yet.
    const manifest: AppManifest = {
      name: engineManifest.app.name,
      description: engineManifest.app.description ?? `${engineManifest.entities?.length ?? 0} entity type(s), ${tools.length} tool(s)`,
      emoji: engineManifest.app.emoji,
      color: engineManifest.app.color,
    };
    apps.push({ manifest, dir: appDir, engine: { entities: engineManifest.entities ?? [], tools } });

    const skillsDir = join(appDir, "skills");
    if (existsSync(skillsDir)) {
      skillPaths.push(skillsDir);
    }

    if (tools.length > 0) {
      mcpServers.push({ name: engineManifest.app.id, url: `${engineUrl}/mcp/${engineManifest.app.id}` });
    }
  }

  return { apps, capabilities: { skillPaths, mcpServers } };
}
