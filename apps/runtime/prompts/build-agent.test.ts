import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT_PATH = fileURLToPath(new URL("./build-agent.md", import.meta.url));
const SKILLS_DIR = fileURLToPath(new URL("./skills", import.meta.url));
const EXPECTED_SKILLS = ["app-design", "manifest", "tools", "ui", "seed-data", "app-skills"];

test("system prompt stays compact (roughly 1.5k-2.5k tokens, ~4 chars/token)", () => {
  const prompt = readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
  const approxTokens = prompt.length / 4;
  assert.ok(approxTokens < 3000, `system prompt looks too large: ~${Math.round(approxTokens)} tokens`);
});

test("system prompt names all four custom tools", () => {
  const prompt = readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
  for (const tool of ["ask_questions", "update_plan", "validate_app", "present_app"]) {
    assert.match(prompt, new RegExp(tool), `system prompt should mention ${tool}`);
  }
});

test("system prompt preserves critical invariants", () => {
  const prompt = readFileSync(SYSTEM_PROMPT_PATH, "utf-8").toLowerCase();
  assert.match(prompt, /never install/, "must forbid self-install");
  assert.match(prompt, /entities\.d\.ts/, "must warn about generated entity types");
  assert.match(prompt, /at least one entity/, "must require at least one entity");
});

test("system prompt does not mandate ask_questions on every build", () => {
  const prompt = readFileSync(SYSTEM_PROMPT_PATH, "utf-8").toLowerCase();
  assert.ok(
    !/always.{0,20}call `?ask_questions`?/.test(prompt) && !/exactly once/.test(prompt),
    "ask_questions must be conditional (material ambiguity), not a mandatory every-build step"
  );
});

test("builder skills directory exposes exactly the expected skills with valid frontmatter", () => {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: SKILLS_DIR, source: "test" });
  assert.deepEqual(
    skills.map((s) => s.name).sort(),
    [...EXPECTED_SKILLS].sort()
  );
  for (const skill of skills) {
    assert.ok(skill.description.length > 0, `${skill.name} needs a non-empty description`);
  }
  assert.deepEqual(diagnostics, []);
});
