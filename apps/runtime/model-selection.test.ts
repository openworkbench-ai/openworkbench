import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AUTO_MODEL_ID, loadCuratedModels, modelChoices, resolveModelId } from "./model-selection.js";

test("both pickers expose Auto and exactly the four requested models", () => {
  const ids = ["z-ai/glm-5.3-flash", "openai/gpt-6.1-sol", "anthropic/claude-opus-5.5", "minimax/minimax-m3.1-flash"];
  assert.deepEqual(loadCuratedModels().map((model) => model.id), ids);
  for (const useCase of ["chat", "workspace"] as const) {
    const choices = modelChoices(useCase);
    assert.deepEqual(choices.map((model) => model.id), [AUTO_MODEL_ID, ...ids]);
    assert.equal(new Set(choices.map((model) => model.id)).size, 5);
    assert.match(choices[0].name, /^Auto · /);
    for (const id of ids) assert.equal(resolveModelId(id, useCase), id);
    for (const removed of ["openai/gpt-6-sol", "anthropic/claude-sonnet-5", "anthropic/claude-opus-5-5", "unknown", ""]) {
      assert.throws(() => resolveModelId(removed, useCase), /Unknown model/);
    }
  }
});

test("Auto resolves to real SDK models rather than a provider model named auto", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "model-selection-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    modelsPath: new URL("../../pi/models.json", import.meta.url).pathname,
    authPath: join(root, "auth.json"),
    modelsStorePath: join(root, "models-store.json"),
  });
  assert.equal(resolveModelId(AUTO_MODEL_ID, "chat"), "minimax/minimax-m3.1-flash");
  assert.equal(resolveModelId(AUTO_MODEL_ID, "workspace"), "openai/gpt-6.1-sol");
  for (const configured of loadCuratedModels()) {
    const model = runtime.getModel("openrouter", configured.id);
    assert.ok(model, `${configured.id} must be loadable by the SDK`);
    assert.equal(model.id, configured.id);
    assert.equal(model.reasoning, true);
    assert.ok(model.input.includes("image"), `${configured.id} must accept photo attachments`);
    assert.deepEqual(model.cost, configured.cost);
  }
});
