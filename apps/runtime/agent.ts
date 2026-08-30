import { loadApps, loadCatalogApps, type Capabilities } from "./app-loader.js";
import { createPiAgentBackend } from "./backends/pi.js";

const DEFAULT_PROMPT = "What files are in the current directory?";
const APPS_DIR = new URL("..", import.meta.url).pathname;
const CATALOG_DIR = new URL("../../catalog", import.meta.url).pathname;

// Swap this to switch agent backends; both must satisfy AgentBackend.
const createAgentBackend = createPiAgentBackend;

async function main() {
  const prompt = process.argv[2] ?? DEFAULT_PROMPT;

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

  const backend = await createAgentBackend(capabilities);
  await backend.prompt(prompt, (event) => {
    if (event.type === "text") process.stdout.write(event.delta);
    if (event.type === "tool_start") console.error(`[tool] ${event.toolName}`);
  });
  process.stdout.write("\n");

  // Force exit: an MCP server's streaming HTTP connection can otherwise keep
  // the event loop alive past the end of this one-shot run.
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
