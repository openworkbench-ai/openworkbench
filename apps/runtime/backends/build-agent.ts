import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentBackend, AppDraft } from "../agent-backend.js";
import { createBuildTools, readAppBundle, saveAndInstall } from "../build-tools.js";

const MODEL_PROVIDER = "openrouter";
export const DEFAULT_MODEL_ID = "z-ai/glm-5.3-flash";

const SKILLS_DIR = new URL("../skills", import.meta.url).pathname;

const AGENTS_MD = `# Build agent

You draft new Open Workbench apps in this directory using your normal file
tools (read/write/edit/ls/grep/find). This is a scratch workspace, not the
live catalog -- nothing here is served until the user installs it.

Consult the \`build-app\` skill for the manifest format, file layout, and
workflow before drafting anything. In short:

1. ALWAYS call \`ask_questions\` exactly once before writing any files --
   even if the request seems fully specified. Every app has open decisions
   (which fields matter most, what's required vs optional, what a sensible
   default is) and the user gets exactly one easy chance to steer before you
   commit to a design, so use it. Never skip this step.
2. Call \`update_plan\` with your steps and keep it current -- resend the
   full list with updated statuses -- as you work through them.
3. Draft \`<id>/manifest.json\` (and optionally \`<id>/skills/\`,
   \`<id>/data/\`).
4. Call \`validate_app\` until it reports no errors.
5. Call \`present_app\` to hand the finished, validated draft to the user as
   a review card. This does NOT install it -- installing is the user's own
   action, from a button on that card. Your job ends once you've presented
   a valid draft; if the user then asks for changes, edit the files,
   re-validate, and call \`present_app\` again to refresh the card.

Never call \`present_app\` before \`validate_app\` reports the manifest is
valid, and never try to install or activate anything yourself -- there is
no tool for that here on purpose. Do not run shell commands -- you have no
\`bash\` tool here, only file tools and the four custom tools
(ask_questions, update_plan, validate_app, present_app).
`;

/**
 * Builds the app-authoring agent backend: a Pi coding-agent session scoped
 * to a fresh scratch workspace, with native file tools for drafting and
 * four custom tools (ask_questions, update_plan, validate_app,
 * present_app) for talking to the user and the engine. Structurally
 * parallel to createPiAgentBackend, but deliberately does not share its
 * capabilities (installed apps' skills/MCP tools) -- this agent's job is
 * to produce a new app, not use existing ones.
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
  writeFileSync(join(workspaceRoot, "AGENTS.md"), AGENTS_MD);

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
    additionalSkillPaths: [SKILLS_DIR],
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
      return {
        id,
        app: manifest.app,
        entities: manifest.entities ?? [],
        tools: manifest.tools ?? [],
        skills: bundle.skills.map((s) => s.name),
        data: bundle.data.map((d) => ({ entity: d.entity, count: d.rows.length })),
      };
    },
    installDraft(id) {
      return saveAndInstall(workspaceRoot, engineUrl, id);
    },
    async dispose() {
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}
