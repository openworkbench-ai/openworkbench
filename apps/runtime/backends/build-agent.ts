import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { extractUiResource, type AgentBackend, type AppDraft } from "../agent-backend.js";
import { createBuildTools, readAppBundle, saveAndInstall } from "../build-tools.js";

const MODEL_PROVIDER = "openrouter";
export const DEFAULT_MODEL_ID = "z-ai/glm-5.3-flash";

const SYSTEM_PROMPT = readFileSync(
  new URL("../prompts/build-agent.md", import.meta.url),
  "utf-8"
);

/**
 * Builds the app-authoring agent backend: a Pi coding-agent session scoped
 * to a fresh scratch workspace, with native file tools for drafting and
 * four custom tools (ask_questions, update_plan, validate_app,
 * present_app) for talking to the user and the engine. Structurally
 * parallel to createPiAgentBackend, but deliberately does not share its
 * capabilities (installed apps' skills/MCP tools) -- this agent's job is
 * to produce a new app, not use existing ones. It does load its own set of
 * Open Workbench platform-knowledge skills (apps/runtime/prompts/skills/)
 * on demand, alongside the compact behavioral SYSTEM_PROMPT below -- see
 * that file for why the split exists.
 */
export async function createBuildAgentBackend(
  engineUrl: string,
  initialModelId: string = DEFAULT_MODEL_ID
): Promise<AgentBackend> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OPENROUTER_API_KEY. Set it in your environment (see .env.example) and try again."
    );
  }

  const workspaceRoot = mkdtempSync(join(tmpdir(), "owb-build-"));
  // A symlink, not a per-session `npm install`: any <id>/ui/components/*.tsx
  // the agent writes imports "@openworkbench/app-ui-kit" as a bare
  // specifier, resolved by Node/Vite/tsc walking up from the component's own
  // directory looking for a node_modules -- this is the one they'll find.
  symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(workspaceRoot, "node_modules"));

  const modelRuntime = await ModelRuntime.create({
    modelsPath: new URL("../../../pi/models.json", import.meta.url).pathname,
  });
  await modelRuntime.setRuntimeApiKey(MODEL_PROVIDER, apiKey);
  let modelId = initialModelId;
  const model = modelRuntime.getModel(MODEL_PROVIDER, modelId);

  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspaceRoot,
    agentDir,
    settingsManager: SettingsManager.create(workspaceRoot, agentDir),
    // Modular Open Workbench platform knowledge (app-design, manifest,
    // tools, ui, seed-data, app-skills) -- see apps/runtime/prompts/skills/
    // -- loaded on-demand rather than baked into SYSTEM_PROMPT below.
    additionalSkillPaths: [fileURLToPath(new URL("../prompts/skills", import.meta.url))],
    // Full replace, not append -- see apps/runtime/prompts/build-agent.md.
    systemPromptOverride: () => SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const { tools: buildTools, respondToTool } = createBuildTools(workspaceRoot, engineUrl);

  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    modelRuntime,
    model,
    resourceLoader,
    // `tools` is an allowlist that also filters customTools (not just
    // built-ins) -- omitting one of the four custom tools here would
    // silently disable it, so their names must be listed explicitly
    // alongside the built-ins this agent is allowed (no bash/powershell).
    tools: ["read", "write", "edit", "ls", "grep", "find", ...buildTools.map((t) => t.name)],
    customTools: buildTools,
    sessionManager: SessionManager.inMemory(),
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
    respondToTool,
    readDraft(id): AppDraft | null {
      const bundle = readAppBundle(workspaceRoot, id);
      if ("error" in bundle) return null;
      let manifest: { app?: AppDraft["app"]; entities?: unknown[]; tools?: unknown[] };
      try {
        manifest = JSON.parse(bundle.manifestRaw);
      } catch {
        return null;
      }
      if (!manifest.app) return null;
      const componentsDir = join(workspaceRoot, id, "ui", "components");
      const ui = existsSync(componentsDir)
        ? readdirSync(componentsDir)
            .filter((f) => f.endsWith(".tsx"))
            .map((f) => f.slice(0, -".tsx".length))
        : [];
      return {
        id,
        app: manifest.app,
        entities: manifest.entities ?? [],
        tools: manifest.tools ?? [],
        skills: bundle.skills.map((s) => s.name),
        data: bundle.data.map((d) => ({ entity: d.entity, count: d.rows.length })),
        ui,
      };
    },
    installDraft(id) {
      return saveAndInstall(workspaceRoot, engineUrl, id);
    },
    async dispose() {
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
    async abort() {
      await session.abort();
    },
  };
}
