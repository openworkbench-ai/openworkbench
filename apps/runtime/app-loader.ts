import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AppManifest {
  name: string;
  description: string;
}

export interface LoadedApp {
  manifest: AppManifest;
  dir: string;
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
