import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { extractUiResource, type AgentBackend } from "../agent-backend.js";
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
    // This agent converses, researches the web and uses installed apps' MCP tools --
    // never to read/write files or run shell commands. `tools` as an
    // explicit allowlist (rather than the ambiguous default-active-tools
    // behavior) also filters customTools by the same rule, so it must name
    // them too, not just omit the built-ins.
    tools: customTools.map((tool) => tool.name),
    customTools,
  });

  return {
    supportsImages() {
      return session.model?.input.includes("image") ?? false;
    },
    async prompt(text, onEvent, images = []) {
      if (images.length && !session.model?.input.includes("image")) {
        throw new Error("This model does not support images. Choose an image-capable model and try again.");
      }
      let failure: string | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "text_delta") {
            onEvent({ type: "text", delta: event.assistantMessageEvent.delta });
          } else if (event.assistantMessageEvent.type === "thinking_delta") {
            onEvent({ type: "thinking", delta: event.assistantMessageEvent.delta });
          }
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          // Wait for the SDK's retries before reporting a provider failure.
          failure = event.message.stopReason === "error"
            ? event.message.errorMessage || "The model request failed."
            : undefined;
        } else if (event.type === "tool_execution_start") {
          onEvent({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        } else if (event.type === "tool_execution_end") {
          onEvent({
            type: "tool_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
            ...extractUiResource(event.result),
          });
        } else if (event.type === "compaction_end" && !event.willRetry && event.errorMessage) {
          // The SDK's one automatic compact-and-retry attempt (for a response
          // truncated at the model's maxTokens) failed -- surface it instead
          // of letting the stream end with no assistant text.
          onEvent({ type: "error", reason: event.errorMessage });
        }
      });
      try {
        await session.prompt(text, {
          images: images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })),
        });
        if (failure) onEvent({ type: "error", reason: failure });
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
      // setModel carries the current thinking level forward; a non-reasoning
      // model forces it to "off", which then silently disables reasoning on
      // the model being switched to unless we bump it back up here.
      if (nextModel.reasoning && session.thinkingLevel === "off") {
        session.setThinkingLevel("medium");
      }
      modelId = nextModelId;
    },
    getModelId() {
      return modelId;
    },
    async abort() {
      await session.abort();
    },
  };
}
