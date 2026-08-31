import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentBackend } from "../agent-backend.js";
import type { Capabilities } from "../app-loader.js";
import { createCapabilityProvider } from "./pi-capabilities.js";

const MODEL_PROVIDER = "openrouter";
export const DEFAULT_MODEL_ID = "z-ai/glm-5.3-flash";

export async function createPiAgentBackend(
  capabilities: Capabilities = { skillPaths: [], mcpServers: [] },
  initialModelId: string = DEFAULT_MODEL_ID
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
  let modelId = initialModelId;
  const model = modelRuntime.getModel(MODEL_PROVIDER, modelId);

  const { resourceLoader, tools: customTools } = await createCapabilityProvider(capabilities);

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    model,
    resourceLoader,
    // This agent's job is to converse and use installed apps' MCP tools --
    // never to read/write files or run shell commands. `tools` as an
    // explicit allowlist (rather than the ambiguous default-active-tools
    // behavior) also filters customTools by the same rule, so it must name
    // them too, not just omit the built-ins.
    tools: customTools.map((tool) => tool.name),
    customTools,
  });

  return {
    async prompt(text, onEvent) {
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "text_delta") {
            onEvent({ type: "text", delta: event.assistantMessageEvent.delta });
          } else if (event.assistantMessageEvent.type === "thinking_delta") {
            onEvent({ type: "thinking", delta: event.assistantMessageEvent.delta });
          }
        } else if (event.type === "tool_execution_start") {
          onEvent({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        } else if (event.type === "tool_execution_end") {
          onEvent({ type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
        }
      });
      try {
        await session.prompt(text);
      } finally {
        unsubscribe();
      }
    },
    async setModel(nextModelId) {
      const nextModel = modelRuntime.getModel(MODEL_PROVIDER, nextModelId);
      if (!nextModel) {
        throw new Error(`Unknown model "${nextModelId}" for provider "${MODEL_PROVIDER}".`);
      }
      await session.setModel(nextModel);
      modelId = nextModelId;
    },
    getModelId() {
      return modelId;
    },
  };
}
