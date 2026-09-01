import { readFileSync } from "node:fs";
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Capabilities } from "../app-loader.js";
import { createMcpProxyTool } from "../mcp-tools.js";

export interface CapabilityProvider {
  resourceLoader: ResourceLoader;
  tools: ToolDefinition[];
}

const SYSTEM_PROMPT = readFileSync(
  new URL("../prompts/normal-agent.md", import.meta.url),
  "utf-8"
);

/**
 * Assembles everything an agent backend needs to act on installed apps'
 * capabilities: a resource loader that surfaces their skills, and a tool
 * list that proxies their configured MCP servers. Kept separate from the
 * agent backend itself so capability provisioning can change (e.g. new
 * capability types) without touching model/session setup.
 */
export async function createCapabilityProvider(
  capabilities: Capabilities
): Promise<CapabilityProvider> {
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    additionalSkillPaths: capabilities.skillPaths,
    // Full replace, not append -- see apps/runtime/prompts/normal-agent.md.
    systemPromptOverride: () => SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const mcpProxyTool = await createMcpProxyTool(capabilities.mcpServers);

  return {
    resourceLoader,
    tools: mcpProxyTool ? [mcpProxyTool] : [],
  };
}
