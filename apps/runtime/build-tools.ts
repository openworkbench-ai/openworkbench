import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildAppUI, generateEntityTypes } from "@openworkbench/app-ui-kit/build";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

/**
 * The build agent's four custom tools: two human-in-the-loop tools that
 * never leave the process (ask_questions, update_plan), a side-effect-free
 * dry-run validator (validate_app), and a step that re-validates and hands
 * the draft to the user for review (present_app) -- it does NOT install
 * anything; installing is a separate, user-initiated action in the UI
 * (`saveAndInstall`, called from a plain HTTP route in server.ts, never by
 * the agent itself). Everything else the build agent does -- drafting
 * manifest.json, skills/*\/SKILL.md, data/*.json -- happens through its
 * native read/write/edit tools against files under `workspaceRoot`.
 */

const APP_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_RESULT_CHARS = 4000;

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated ${text.length - MAX_RESULT_CHARS} more characters]`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text: truncate(text) }], details: undefined };
}

export interface AppBundle {
  manifestRaw: string;
  skills: { name: string; content: string }[];
  data: { entity: string; rows: unknown[] }[];
}

/** Reads `<workspaceRoot>/<id>/{manifest.json, skills/*\/SKILL.md, data/*.json}` off disk. */
export function readAppBundle(workspaceRoot: string, id: string): AppBundle | { error: string } {
  const appDir = join(workspaceRoot, id);
  const manifestPath = join(appDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { error: `No manifest.json found under "${id}/" in the workspace. Write one first.` };
  }

  const manifestRaw = readFileSync(manifestPath, "utf-8");
  try {
    JSON.parse(manifestRaw);
  } catch (err) {
    return { error: `"${id}/manifest.json" is not valid JSON: ${(err as Error).message}` };
  }

  const skills: AppBundle["skills"] = [];
  const skillsDir = join(appDir, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, entry, "SKILL.md");
      if (statSync(join(skillsDir, entry)).isDirectory() && existsSync(skillFile)) {
        skills.push({ name: entry, content: readFileSync(skillFile, "utf-8") });
      }
    }
  }

  const data: AppBundle["data"] = [];
  const dataDir = join(appDir, "data");
  if (existsSync(dataDir)) {
    for (const entry of readdirSync(dataDir)) {
      if (!entry.endsWith(".json")) continue;
      const entity = entry.slice(0, -".json".length);
      try {
        const rows = JSON.parse(readFileSync(join(dataDir, entry), "utf-8"));
        data.push({ entity, rows: Array.isArray(rows) ? rows : [rows] });
      } catch (err) {
        return { error: `"${id}/data/${entry}" is not valid JSON: ${(err as Error).message}` };
      }
    }
  }

  return { manifestRaw, skills, data };
}

export interface AppUIComponent {
  name: string;
  html: string;
}

/**
 * Type-checks `<id>/ui/components/*.tsx` against the generated entity prop
 * types and the design kit's own types, without emitting anything. Vite's
 * own build (below) only strips types via esbuild -- it would happily
 * "succeed" on a component with the wrong prop name, so this is the actual
 * correctness gate, the same way validate_app is for manifest.json.
 */
async function typecheckAppUI(appDir: string): Promise<{ ok: true } | { ok: false; output: string }> {
  const tsconfigPath = join(appDir, "ui", ".tsconfig.generated.json");
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
      },
      include: ["components/**/*.tsx", "generated/**/*.d.ts"],
    }),
    "utf-8"
  );

  try {
    await execFileAsync(join(appDir, "..", "node_modules", ".bin", "tsc"), ["--noEmit", "-p", tsconfigPath]);
    return { ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: (e.stdout || e.stderr || e.message).trim() };
  }
}

/**
 * Runs the full ui/ pipeline for one drafted app: regenerate entity prop
 * types from its manifest, type-check every component against them, then
 * (only if that passes) compile each into a self-contained MCP Apps HTML
 * bundle via @openworkbench/app-ui-kit. A no-op (`{ components: [] }`) for
 * an app that declares no ui/components directory at all. Shared by
 * validate_app/present_app (surfacing errors back to the agent) and
 * saveAndInstall (bundling the built HTML into the install request).
 */
export async function buildAppUi(
  workspaceRoot: string,
  id: string
): Promise<{ components: AppUIComponent[] } | { error: string }> {
  const appDir = join(workspaceRoot, id);
  if (!existsSync(join(appDir, "ui", "components"))) return { components: [] };

  const manifestPath = join(appDir, "manifest.json");
  let manifest: { app?: { color?: string } };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    return { error: `"${id}/manifest.json" is not valid JSON: ${(err as Error).message}` };
  }

  generateEntityTypes(manifestPath, join(appDir, "ui", "generated", "entities.d.ts"));

  const typechecked = await typecheckAppUI(appDir);
  if (!typechecked.ok) {
    return { error: `ui/components has type errors:\n${typechecked.output}` };
  }

  try {
    const built = await buildAppUI({ appDir, accentColor: manifest.app?.color });
    return { components: built.map((b) => ({ name: b.component, html: b.html })) };
  } catch (err) {
    return { error: `ui/components failed to build: ${(err as Error).message}` };
  }
}

export interface AnsweredQuestion {
  id: string;
  answer: string | string[];
}

/** Runs the drafted manifest through the engine's dry-run `/validate`, shared by `validate_app` and `present_app`. */
async function validateDraft(
  workspaceRoot: string,
  engineUrl: string,
  id: string
): Promise<{ valid: boolean; body: string } | { error: string }> {
  const bundle = readAppBundle(workspaceRoot, id);
  if ("error" in bundle) return { error: bundle.error };

  const res = await fetch(`${engineUrl}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bundle.manifestRaw,
  });
  const body = await res.text();
  if (!res.ok && res.status !== 422) {
    throw new Error(`engine /validate returned ${res.status}: ${body}`);
  }
  let parsed: { valid?: boolean } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    // fall through with valid: false below
  }
  return { valid: parsed.valid === true, body };
}

/**
 * Saves the drafted app bundle to the engine's catalog and installs it,
 * making it live. This is the one thing in the build flow the agent never
 * calls itself -- it's invoked directly from an HTTP route (see
 * server.ts's `/api/build-chat/install`) once the user clicks "Install" on
 * the review card `present_app` produced.
 */
export async function saveAndInstall(
  workspaceRoot: string,
  engineUrl: string,
  id: string
): Promise<{ ok: true; message: string } | { ok: false; status: number; message: string }> {
  if (!APP_ID_PATTERN.test(id)) {
    return { ok: false, status: 400, message: `"${id}" is not a valid app id (expected ^[a-z][a-z0-9_]*$).` };
  }
  const bundle = readAppBundle(workspaceRoot, id);
  if ("error" in bundle) return { ok: false, status: 400, message: bundle.error };

  const ui = await buildAppUi(workspaceRoot, id);
  if ("error" in ui) return { ok: false, status: 400, message: `UI build failed: ${ui.error}` };

  const saveRes = await fetch(`${engineUrl}/admin/apps/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      manifest: JSON.parse(bundle.manifestRaw),
      skills: bundle.skills.length > 0 ? bundle.skills : undefined,
      data: bundle.data.length > 0 ? bundle.data : undefined,
      ui: ui.components.length > 0 ? ui.components : undefined,
    }),
  });
  const saveBody = await saveRes.text();
  if (!saveRes.ok) {
    return { ok: false, status: saveRes.status, message: `Save rejected: ${saveBody}` };
  }

  const installRes = await fetch(`${engineUrl}/admin/apps/${id}/install`, { method: "POST" });
  const installBody = await installRes.text();
  if (!installRes.ok) {
    return { ok: false, status: installRes.status, message: `Saved, but install was rejected: ${installBody}` };
  }

  return { ok: true, message: installBody };
}

/**
 * Builds this build-agent session's four tools -- two human-in-the-loop
 * (ask_questions, update_plan) that never leave the process, and two
 * engine-facing (validate_app, present_app) -- closed over that session's
 * scratch workspace root. `respondToTool` resolves a pending
 * `ask_questions` call by its tool-call id; it's how the frontend's answer
 * gets back into the agent's still-running `execute`.
 */
export function createBuildTools(
  workspaceRoot: string,
  engineUrl: string
): { tools: ToolDefinition[]; respondToTool: (toolCallId: string, value: unknown) => boolean } {
  const pendingAnswers = new Map<string, (answers: AnsweredQuestion[]) => void>();

  const askQuestions = defineTool({
    name: "ask_questions",
    label: "Ask questions",
    description:
      "Ask the user one or more questions to resolve open design decisions before drafting the app. Each " +
      "question is `single_choice` (pick one option), `multiple_choice` (pick any number of options), or " +
      "`free_text` (type an open-ended answer, no options). Blocks until the user answers in the UI. Call this " +
      "once, with every open question batched together, rather than one question at a time.",
    promptSnippet:
      "ask_questions({ questions }) - batch every open design decision (single_choice, multiple_choice, or free_text) into one call and wait for the user's answers",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.String({ description: "A short unique identifier for this question, e.g. \"auth\"." }),
          question: Type.String({ description: "The question text shown to the user." }),
          type: Type.Union(
            [Type.Literal("single_choice"), Type.Literal("multiple_choice"), Type.Literal("free_text")],
            { description: "single_choice/multiple_choice need `options`; free_text does not." }
          ),
          options: Type.Optional(
            Type.Array(Type.String(), {
              minItems: 2,
              description: "The choices the user can pick from. Required for single_choice and multiple_choice; omit for free_text.",
            })
          ),
        }),
        { minItems: 1 }
      ),
    }),
    async execute(toolCallId, params) {
      // The declared schema is only a hint to the model -- nothing here re-validates a tool call's args
      // against it at runtime, so a smaller/faster model can still send malformed options (e.g.
      // `{id, name, description}` objects instead of plain strings) or skip `options` on a choice
      // question. Catch that before it ever reaches the UI, with an error specific enough to self-correct.
      for (const q of params.questions) {
        if (q.type === "free_text") continue;
        if (!q.options || q.options.length < 2) {
          throw new Error(
            `ask_questions: question "${q.id}" is "${q.type}" and needs an "options" array with at least 2 ` +
              `plain string choices. Call ask_questions again with options included.`
          );
        }
        const badOption = q.options.find((o) => typeof o !== "string");
        if (badOption !== undefined) {
          throw new Error(
            `ask_questions: question "${q.id}"'s options must each be a plain string (e.g. "Yes"), not an ` +
              `object like ${JSON.stringify(badOption)}. Call ask_questions again with string options only.`
          );
        }
      }

      const answers = await new Promise<AnsweredQuestion[]>((resolve) => {
        pendingAnswers.set(toolCallId, resolve);
      });
      const byId = new Map(params.questions.map((q) => [q.id, q.question]));
      const lines = answers.map((a) => {
        const answer = Array.isArray(a.answer) ? a.answer.join(", ") : a.answer;
        return `- ${byId.get(a.id) ?? a.id}: ${answer}`;
      });
      return textResult(`User answered:\n${lines.join("\n")}`);
    },
  });

  const updatePlan = defineTool({
    name: "update_plan",
    label: "Update plan",
    description:
      "Show the user the build plan as a checklist. Call it once with every step you intend to take (all " +
      "\"pending\"), then call it again with the full list any time a step's status changes, so the user watches " +
      "real progress.",
    promptSnippet: "update_plan({ steps }) - resend the full step list any time a step's status changes",
    parameters: Type.Object({
      steps: Type.Array(
        Type.Object({
          id: Type.String({ description: "A short unique identifier for this step." }),
          label: Type.String({ description: "What this step is, e.g. \"Draft manifest.json\"." }),
          status: Type.Union([Type.Literal("pending"), Type.Literal("active"), Type.Literal("done"), Type.Literal("failed")]),
        }),
        { minItems: 1 }
      ),
    }),
    async execute() {
      return textResult("Plan updated.");
    },
  });

  const validateApp = defineTool({
    name: "validate_app",
    label: "Validate app",
    description:
      "Dry-run validate the manifest.json drafted at <workspace>/<id>/manifest.json against the engine's schema, " +
      "and type-check any ui/components/*.tsx against the manifest's entities, without writing or installing " +
      "anything. Safe to call repeatedly while iterating.",
    promptSnippet: "validate_app({ id }) - check a drafted manifest (and any ui components) against the engine before committing",
    parameters: Type.Object({
      id: Type.String({ description: "The app id — matches the workspace subdirectory and manifest.json's app.id." }),
    }),
    async execute(_toolCallId, params) {
      if (!APP_ID_PATTERN.test(params.id)) {
        return textResult(`"${params.id}" is not a valid app id (expected ^[a-z][a-z0-9_]*$).`);
      }
      const result = await validateDraft(workspaceRoot, engineUrl, params.id);
      if ("error" in result) return textResult(result.error);
      const ui = await buildAppUi(workspaceRoot, params.id);
      if ("error" in ui) return textResult(`${result.body}\n\n${ui.error}`);
      return textResult(result.body);
    },
  });

  const presentApp = defineTool({
    name: "present_app",
    label: "Present app",
    description:
      "Re-validate the drafted app and, if it's valid, hand it to the user for review as a card with an install " +
      "button -- you do NOT install anything by calling this. Call it once you're done drafting and validate_app " +
      "reports no errors; call it again after any further edits the user asks for, to refresh the card.",
    promptSnippet: "present_app({ id }) - hand a validated draft to the user for review; they install it themselves",
    parameters: Type.Object({
      id: Type.String({ description: "The app id — matches the workspace subdirectory and manifest.json's app.id." }),
    }),
    async execute(_toolCallId, params) {
      if (!APP_ID_PATTERN.test(params.id)) {
        throw new Error(`"${params.id}" is not a valid app id (expected ^[a-z][a-z0-9_]*$).`);
      }
      const result = await validateDraft(workspaceRoot, engineUrl, params.id);
      if ("error" in result) throw new Error(result.error);
      if (!result.valid) {
        throw new Error(`Draft is not valid yet -- fix these and re-validate before presenting: ${result.body}`);
      }
      const ui = await buildAppUi(workspaceRoot, params.id);
      if ("error" in ui) {
        throw new Error(`Draft's UI is not valid yet -- fix and re-validate before presenting: ${ui.error}`);
      }
      return textResult("Draft is valid; showing it to the user for review now.");
    },
  });

  return {
    tools: [askQuestions, updatePlan, validateApp, presentApp],
    respondToTool(toolCallId, value) {
      const resolve = pendingAnswers.get(toolCallId);
      if (!resolve) return false;
      pendingAnswers.delete(toolCallId);
      resolve(value as AnsweredQuestion[]);
      return true;
    },
  };
}
