import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createWorkspaceRoutes } from "./workspace-routes.js";

async function fixture(t: TestContext, engineHandler?: RequestListener) {
  const root = mkdtempSync(join(tmpdir(), "workspace-routes-test-"));
  const engine = createServer(
    engineHandler ??
      ((_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            valid: true,
            migration: [],
            permissions: { network: [], model: false, data: [] },
          }),
        );
      }),
  );
  engine.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => engine.once("listening", resolve));
  const enginePort = (engine.address() as { port: number }).port;
  const routes = createWorkspaceRoutes({
    root,
    engineUrl: `http://127.0.0.1:${enginePort}`,
    defaultModel: "test",
    models: () => [{ id: "test", name: "Test" }],
    catalogDirFor: () => undefined,
    onApplied: async () => {},
  });
  const server = createServer(async (req, res) => {
    await routes.handle(
      req,
      res,
      new URL(req.url!, "http://localhost"),
      String(req.headers["x-test-user"] ?? "alice"),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/workspaces`;
  t.after(async () => {
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => engine.close(() => resolve())),
    ]);
    rmSync(root, { recursive: true, force: true });
  });
  const request = (path = "", method = "GET", body?: unknown, user = "alice") =>
    fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", "x-test-user": user },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { request, routes };
}

test("workspace HTTP routes isolate users and enforce optimistic source versions", async (t) => {
  const { request } = await fixture(t);
  const created = await request("", "POST", {
    name: "Alice's app",
    template: "blank",
  });
  assert.equal(created.status, 201);
  const p = (await created.json()) as any;
  assert.equal(
    (await request(`/${p.id}`, "GET", undefined, "bob")).status,
    404,
  );
  assert.equal(
    ((await request("", "GET", undefined, "bob").then((r) => r.json())) as any)
      .projects.length,
    0,
  );
  const saved = await request(`/${p.id}`, "PATCH", {
    version: p.version,
    files: { "skills/hello/SKILL.md": "hello" },
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (
      await request(`/${p.id}`, "PATCH", {
        version: p.version,
        files: { "manifest.json": "stale" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/${p.id}`, "PATCH", {
        version: 2,
        files: { "../outside": "bad" },
      })
    ).status,
    400,
  );
  assert.equal((await request(`/${p.id}`, "POST", { version: 2 })).status, 404);
});

test("a validation snapshot excludes concurrent manual edits", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { request } = await fixture(t, async (req, res) => {
    if (req.url === "/validate") {
      entered();
      await paused;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        valid: true,
        migration: [],
        permissions: { network: [], model: false, data: [] },
      }),
    );
  });
  const p = (await (
    await request("", "POST", { template: "blank" })
  ).json()) as any;
  const validating = request(`/${p.id}/validate`, "POST", {
    version: p.version,
  });
  await started;
  const write = await request(`/${p.id}`, "PATCH", {
    version: p.version,
    files: { "manifest.json": "concurrent" },
  });
  assert.equal(write.status, 409);
  assert.equal(((await (await request(`/${p.id}`)).json()) as any).busy, true);
  release();
  assert.equal((await validating).status, 200);
  const final = (await (await request(`/${p.id}`)).json()) as any;
  assert.equal(final.version, p.version);
  assert.equal(final.busy, false);
});

test("invalid manifests remain saved drafts and validation reports their file", async (t) => {
  const { request } = await fixture(t);
  const p = (await (await request("", "POST", {})).json()) as any;
  await request(`/${p.id}`, "PATCH", {
    version: p.version,
    files: { "manifest.json": "{broken" },
  });
  const check = await request(`/${p.id}/validate`, "POST", { version: 2 });
  assert.equal(check.status, 200);
  const result = (await check.json()) as any;
  assert.equal(result.valid, false);
  assert.equal(result.problems[0].path, "manifest.json");
  assert.equal(
    ((await (await request(`/${p.id}`)).json()) as any).files["manifest.json"],
    "{broken",
  );
});
