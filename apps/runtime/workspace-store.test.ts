import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createWorkspaceStore,
  validSourcePath,
  WorkspaceError,
} from "./workspace-store.js";
import { createWorkspaceTools } from "./workspace-agent.js";
import { inspectComponentSource } from "./workspace-source.js";

const manifest = JSON.stringify({
  app: { id: "notes", name: "Notes", version: 1 },
  entities: [
    {
      id: "ent_note",
      name: "note",
      fields: [{ id: "fld_title", name: "title", type: "text" }],
    },
  ],
});
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "workspace-store-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: createWorkspaceStore(root) };
}

test("drafts and revision snapshots survive a new store instance and remain tenant-isolated", (t) => {
  const { root, store } = fixture(t);
  const p = store.create("alice", "notes", { "manifest.json": manifest });
  assert.equal(store.get("bob", "notes"), null);
  const edited = store.update("alice", "notes", p.version, {
    "skills/help/SKILL.md": "instructions",
  });
  const applied = store.applied(
    "alice",
    "notes",
    edited.version,
    "First release",
  );
  const fresh = createWorkspaceStore(root).require("alice", "notes");
  assert.deepEqual(fresh.files, applied.files);
  assert.equal(
    fresh.revisions[0].files["skills/help/SKILL.md"],
    "instructions",
  );
  store.update(
    "alice",
    "notes",
    fresh.version,
    { "skills/help/SKILL.md": "different" },
    "agent",
  );
  assert.equal(
    store.require("alice", "notes").revisions[0].files["skills/help/SKILL.md"],
    "instructions",
  );
});

test("stale writes and restores cannot overwrite a newer draft", (t) => {
  const { store } = fixture(t);
  const p = store.create("alice", "notes", { "manifest.json": manifest }, true);
  const next = store.update("alice", "notes", p.version, {
    "skills/help/SKILL.md": "first",
  });
  assert.throws(
    () =>
      store.update("alice", "notes", p.version, {
        "skills/help/SKILL.md": "stale",
      }),
    (error: unknown) => error instanceof WorkspaceError && error.status === 409,
  );
  assert.throws(
    () => store.restore("alice", "notes", p.version),
    /another tab/,
  );
  const restored = store.restore(
    "alice",
    "notes",
    next.version,
    p.revisions[0].id,
  );
  assert.deepEqual(restored.files, p.files);
  assert.equal(restored.installed, true);
});

test("unsupported paths, generated output and source limits are enforced on every mutation", (t) => {
  const { store } = fixture(t);
  const p = store.create("alice", "notes", { "manifest.json": manifest });
  for (const path of [
    "../secret",
    "/etc/passwd",
    "skills/../../secret/SKILL.md",
    "node_modules/x.ts",
    "ui/generated/entities.d.ts",
    "functions/../secret.py",
    "ui/components/X.tsx?raw",
    "constructor",
    "__proto__",
  ]) {
    assert.equal(validSourcePath(path), false);
    assert.throws(
      () => store.update("alice", "notes", p.version, { [path]: "bad" }),
      /Unsupported/,
    );
  }
  assert.throws(
    () => store.update("alice", "notes", p.version, { "manifest.json": null }),
    /cannot be deleted/,
  );
  assert.throws(
    () =>
      store.update("alice", "notes", p.version, {
        "functions/large.py": "x".repeat((1 << 20) + 1),
      }),
    /limit/,
  );
  assert.equal(store.require("alice", "notes").version, p.version);
});

test("invalid JSON is durably editable, and transcript writes do not invalidate source versions", (t) => {
  const { store } = fixture(t);
  const p = store.create("alice", "notes", { "manifest.json": manifest });
  store.addMessage("alice", "notes", {
    id: "m1",
    role: "user",
    text: "hello",
    at: new Date().toISOString(),
  });
  const next = store.update("alice", "notes", p.version, {
    "manifest.json": "{unfinished",
  });
  assert.equal(next.files["manifest.json"], "{unfinished");
  assert.equal(next.messages.length, 1);
});

test("the agent can edit only the same bounded app draft; it has no install or host file tool", async (t) => {
  const { store } = fixture(t);
  store.create("alice", "notes", { "manifest.json": manifest });
  store.create("alice", "other", { "manifest.json": "other source" });
  const tools = createWorkspaceTools(
    store,
    "alice",
    "notes",
    "http://127.0.0.1:1",
  );
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "delete_file",
      "edit_file",
      "list_files",
      "read_file",
      "read_guide",
      "validate_app",
      "write_file",
    ].sort(),
  );
  const call = (name: string, args: unknown) =>
    (tools.find((t) => t.name === name)!.execute as any)("test", args);
  await assert.rejects(
    call("read_file", { path: "../other/manifest.json" }),
    /No such app file/,
  );
  await assert.rejects(
    call("write_file", { path: "../other/manifest.json", content: "stolen" }),
    /Unsupported/,
  );
  await assert.rejects(
    call("read_guide", { guide: "../../server" }),
    /Unknown guide/,
  );
  await call("write_file", {
    path: "functions/total.py",
    content: "def main(): return 1",
  });
  await assert.rejects(
    call("edit_file", {
      path: "functions/total.py",
      oldText: "not current",
      newText: "bad",
    }),
    /exactly once/,
  );
  await call("edit_file", {
    path: "functions/total.py",
    oldText: "return 1",
    newText: "return 2",
  });
  assert.equal(
    store.require("alice", "notes").files["functions/total.py"],
    "def main(): return 2",
  );
  assert.equal(
    store.require("alice", "notes").authors["functions/total.py"],
    "agent",
  );
  assert.equal(
    store.require("alice", "other").files["manifest.json"],
    "other source",
  );
});

test("component builds cannot embed host files via raw imports, dynamic imports, or Vite globs", () => {
  const cases = [
    "import secret from '/etc/passwd?raw'",
    "import('../secret.json')",
    "import.meta.glob('/etc/**', { eager:true, query:'?raw' })",
    "new URL('/etc/passwd', import.meta.url)",
    "require('node:fs')",
    "import secret from '@openworkbench/app-ui-kit/build'",
  ];
  for (const content of cases)
    assert.ok(
      inspectComponentSource({ "ui/components/Leak.tsx": content }).length,
      content,
    );
  assert.deepEqual(
    inspectComponentSource({
      "ui/components/Card.tsx":
        "import {Card} from '@openworkbench/app-ui-kit'; import type {Note} from '../generated/entities.d.ts'; import {format} from './format';",
      "ui/components/format.ts": "export const format = (x: string) => x",
    }),
    [],
  );
});
