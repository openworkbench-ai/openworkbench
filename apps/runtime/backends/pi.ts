import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentBackend } from "../agent-backend.js";
import type { Capabilities } from "../app-loader.js";
import { createMcpProxyTool } from "../mcp-tools.js";

const MODEL_PROVIDER = "openrouter";
const MODEL_ID = "z-ai/glm-5.3-flash";

export async function createPiAgentBackend(
  capabilities: Capabilities = { skillPaths: [], mcpServers: [] }
): Promise<AgentBackend> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OPENROUTER_API_KEY. Set it in your environment (see .env.example) and try again."
    );
  }

  const modelRuntime = await ModelRuntime.create({
    modelsPath: new URL("../../../pi/models.json", import.meta.url).pathname,
  });
  await modelRuntime.setRuntimeApiKey(MODEL_PROVIDER, apiKey);
  const model = modelRuntime.getModel(MODEL_PROVIDER, MODEL_ID);

  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    additionalSkillPaths: capabilities.skillPaths,
  });
  await resourceLoader.reload();

  const mcpProxyTool = await createMcpProxyTool(capabilities.mcpServers);
  const customTools = mcpProxyTool ? [mcpProxyTool] : [];

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    model,
    resourceLoader,
    customTools,
  });

  return {
    async prompt(text, onTextDelta) {
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          onTextDelta(event.assistantMessageEvent.delta);
        }
      });
      try {
        await session.prompt(text);
      } finally {
        unsubscribe();
      }
    },
  };
}
