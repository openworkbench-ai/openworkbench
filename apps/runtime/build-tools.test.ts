import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAppBundle, saveAndInstall } from "./build-tools.js";

function draft(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "owb-python-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "calculator");
  mkdirSync(join(dir, "functions"), { recursive: true });
  const manifest = {
    app: { id: "calculator", name: "Calculator", version: 1 },
    entities: [{ id: "ent_note", name: "note", fields: [{ id: "f_text", name: "text", type: "text" }] }],
    functions: [{ id: "fn_add", name: "add", runtime: "python", entry: "functions/add.py", capabilities: {} }],
    tools: [{ id: "tool_add", name: "add", function: "fn_add" }],
  };
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, dir, manifest, manifestPath };
}

test("Python source is bundled and sent to the engine on install", async (t) => {
  const { root, dir } = draft(t);
  const source = "def main(): return {'answer': 42}\n";
  writeFileSync(join(dir, "functions", "add.py"), source);
  const bundle = readAppBundle(root, "calculator");
  assert.ok(!("error" in bundle));
  assert.deepEqual(bundle.functionFiles, [{ path: "functions/add.py", content: source }]);
  const requests: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response("{}", { status: 200 });
  });
  assert.equal((await saveAndInstall(root, "http://engine", "calculator")).ok, true);
  assert.deepEqual((requests[0].body as { functionFiles: unknown }).functionFiles, bundle.functionFiles);
  assert.equal(requests[1].url, "http://engine/admin/apps/calculator/install");
});

test("missing Python source is a draft validation error", (t) => {
  const { root } = draft(t);
  const bundle = readAppBundle(root, "calculator");
  assert.ok("error" in bundle);
  assert.match(bundle.error, /Cannot read Python source/);
});

test("Python source cannot traverse or symlink outside the app", (t) => {
  const { root, dir, manifest, manifestPath } = draft(t);
  writeFileSync(join(root, "outside.py"), "secret");
  manifest.functions[0].entry = "functions/../../outside.py";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.ok("error" in readAppBundle(root, "calculator"));
  manifest.functions[0].entry = "functions/add.py";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  symlinkSync(join(root, "outside.py"), join(dir, "functions", "add.py"));
  const bundle = readAppBundle(root, "calculator");
  assert.ok("error" in bundle);
  assert.match(bundle.error, /inside the app directory/);
  assert.equal(readFileSync(join(root, "outside.py"), "utf8"), "secret");
});
