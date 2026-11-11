import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createWorkspaceRoutes } from "./workspace-routes.js";
import {
  createWorkspaceChatState,
  reduceWorkspaceChat,
  type AgentStreamEvent,
} from "../../packages/workspace-chat.js";
import { streamWorkspaceChat } from "../web/src/lib/workspace-api.js";

async function fixture(
  t: TestContext,
  engineHandler?: RequestListener,
  options: Partial<Parameters<typeof createWorkspaceRoutes>[0]> = {},
) {
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
    ...options,
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
  return { request, routes, origin: new URL(base).origin };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  text: string,
) {
  let output = "";
  while (!output.includes(text)) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, `Stream ended before ${text}: ${output}`);
    output += new TextDecoder().decode(chunk.value);
  }
  return output;
}

test("clearing chat persists, preserves the app, and stays scoped to its owner", async (t) => {
  const { request, routes } = await fixture(t);
  const created = (await (await request("", "POST", {})).json()) as any;
  const p = routes.store.applied("alice", created.id, created.version, "Initial app");
  const message = {
    id: "user-message",
    role: "user" as const,
    text: "Help with this app",
    at: new Date().toISOString(),
  };
  routes.store.addMessage("alice", p.id, message);
  routes.store.create("bob", p.id, p.files);
  routes.store.addMessage("bob", p.id, message);
  const other = (await (await request("", "POST", {})).json()) as any;
  routes.store.addMessage("alice", other.id, message);
  const before = (await (await request(`/${p.id}`)).json()) as any;

  assert.equal((await request(`/${p.id}/chat`, "DELETE", {})).status, 400);
  assert.equal(
    (await request(`/${p.id}/chat`, "DELETE", { version: p.version - 1 })).status,
    409,
  );
  assert.deepEqual(routes.store.get("alice", p.id)?.messages, [message]);

  const response = await request(`/${p.id}/chat`, "DELETE", { version: p.version });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...before, messages: [] });
  assert.deepEqual(await (await request(`/${p.id}`)).json(), { ...before, messages: [] });
  assert.deepEqual(routes.store.get("bob", p.id)?.messages, [message]);
  assert.deepEqual(routes.store.get("alice", other.id)?.messages, [message]);
  assert.equal(
    (await request(`/${p.id}/chat`, "DELETE", { version: p.version })).status,
    200,
  );
  assert.equal(
    (await request(`/${other.id}/chat`, "DELETE", { version: other.version }, "bob")).status,
    404,
  );
});

test(
  "chat streams before completion, survives disconnects, and replays without restarting edits",
  { timeout: 10000 },
  async (t) => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    t.after(() => {
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    });
    let calls = 0;
    let active!: Parameters<
      NonNullable<Parameters<typeof createWorkspaceRoutes>[0]["runAgent"]>
    >[0];
    let finish!: () => void;
    const paused = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { request, routes } = await fixture(t, undefined, {
      chatHeartbeatMs: 10,
      runAgent: async (options) => {
        calls++;
        active = options;
        options.onEvent({ type: "assistant_start" });
        options.onEvent({ type: "thinking", delta: "Planning the app" });
        options.onEvent({
          type: "tool_call",
          toolCallId: "write-1",
          toolName: "write_file",
          args: { path: "skills/demo/SKILL.md" },
        });
        await paused;
      },
    });
    const p = (await (await request("", "POST", {})).json()) as any;
    const body = {
      runId: "run-1",
      version: p.version,
      message: "Build it",
      modelId: "test",
    };
    const response = await request(`/${p.id}/chat`, "POST", body);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const reader = response.body!.getReader();
    const early = await readUntil(reader, "keepalive");
    assert.match(early, /Planning the app/);
    assert.match(early, /tool_call/);
    assert.doesNotMatch(early, /"done"/);
    await reader.cancel();
    assert.equal(active.signal.aborted, false);
    const detached = await (await request(`/${p.id}`)).json() as any;
    assert.equal(detached.activeRunId, "run-1");
    assert.equal(
      (await request(`/${p.id}/chat`, "DELETE", { version: p.version })).status,
      409,
    );
    assert.equal(routes.store.get("alice", p.id)?.messages.length, 1);
    assert.equal(
      (await request(`/${p.id}`, "PATCH", { version: p.version, files: {} }))
        .status,
      409,
    );
    assert.equal(
      (await request(`/${p.id}/chat?runId=run-1`, "GET", undefined, "bob"))
        .status,
      404,
    );
    assert.equal(
      (await request(`/${p.id}/chat?runId=run-1&after=-1`)).status,
      400,
    );
    active.onEvent({
      type: "tool_start",
      toolCallId: "write-1",
      toolName: "write_file",
      args: { path: "skills/demo/SKILL.md", content: "hello" },
    });
    routes.store.update(
      "alice",
      p.id,
      p.version,
      { "skills/demo/SKILL.md": "hello" },
      "agent",
    );
    active.onEvent({
      type: "tool_end",
      toolCallId: "write-1",
      toolName: "write_file",
      result: { saved: true },
      isError: false,
    });
    active.onEvent({ type: "text", delta: "Built it." });
    finish();
    const replay = await (
      await request(`/${p.id}/chat?runId=run-1&after=3`)
    ).text();
    assert.doesNotMatch(replay, /Planning the app/);
    assert.match(replay, /"tool_start"/);
    assert.match(replay, /"tool_end"/);
    assert.match(replay, /"done"/);
    // Repeating even the original stale-version POST attaches to the same completed run.
    await (await request(`/${p.id}/chat`, "POST", body)).text();
    assert.equal(calls, 1);
    const final = (await (await request(`/${p.id}`)).json()) as any;
    assert.equal(final.busy, false);
    assert.equal(final.activeRunId, undefined);
    assert.equal(final.messages.length, 2);
    assert.equal(final.messages[1].thinking, "Planning the app");
    assert.deepEqual(final.messages[1].segments.map((segment: { kind: string }) => segment.kind), [
      "thinking", "tool", "text",
    ]);
    assert.equal(final.messages[1].segments[0].streaming, false);
    assert.equal(final.messages[1].tools[0].status, "done");
    assert.match(final.messages[1].tools[0].result, /saved/);
    assert.equal(final.files["skills/demo/SKILL.md"], "hello");
  },
);

test(
  "explicit stop cancels the run, saves partial activity and releases the app lock",
  { timeout: 10000 },
  async (t) => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    t.after(() => {
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    });
    const { request } = await fixture(t, undefined, {
      runAgent: async ({ signal, onEvent }) => {
        onEvent({ type: "thinking", delta: "Started" });
        onEvent({
          type: "tool_start",
          toolCallId: "read",
          toolName: "read_file",
          args: {},
        });
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    const p = (await (await request("", "POST", {})).json()) as any;
    const response = await request(`/${p.id}/chat`, "POST", {
      runId: "stop-me",
      version: p.version,
      message: "Build it",
    });
    const reader = response.body!.getReader();
    await readUntil(reader, "tool_start");
    assert.equal(
      (await request(`/${p.id}/chat-stop`, "POST", { runId: "stop-me" }))
        .status,
      200,
    );
    const ending = await readUntil(reader, '"done"');
    assert.match(ending, /Stopped/);
    await reader.cancel();
    const final = (await (await request(`/${p.id}`)).json()) as any;
    assert.equal(final.busy, false);
    assert.match(final.messages[1].error, /Stopped/);
    assert.equal(final.messages[1].tools[0].status, "interrupted");
  },
);

for (const lostInitialResponse of [false, true])
  test(
    `browser transport recovers ${lostInitialResponse ? "a lost initial response" : "a dropped stream"} without duplicate work`,
    { timeout: 10000 },
    async (t) => {
      const previousKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "test-key";
      t.after(() => {
        if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = previousKey;
      });
      let calls = 0;
      const { request, origin } = await fixture(t, undefined, {
        runAgent: async ({ onEvent }) => {
          calls++;
          onEvent({ type: "thinking", delta: "Thinking live" });
          onEvent({
            type: "tool_start",
            toolCallId: "read",
            toolName: "read_file",
            args: { path: "manifest.json" },
          });
          onEvent({
            type: "tool_end",
            toolCallId: "read",
            toolName: "read_file",
            result: "source",
            isError: false,
          });
          onEvent({ type: "text", delta: "Finished" });
        },
      });
      const p = (await (await request("", "POST", {})).json()) as any;
      const originalFetch = globalThis.fetch;
      const requests: string[] = [];
      t.mock.method(
        globalThis,
        "fetch",
        async (input: string, init?: RequestInit) => {
          const url = new URL(input, origin);
          requests.push(
            `${init?.method ?? "GET"} ${url.pathname}${url.search}`,
          );
          const response = await originalFetch(url, init);
          if (requests.length !== 1) return response;
          // A proxy drops the response after delivering the first complete event.
          await response.body!.cancel();
          if (lostInitialResponse) throw new TypeError("Network error");
          let delivered = false;
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (!delivered) {
                  delivered = true;
                  controller.enqueue(
                    new TextEncoder().encode(
                      'id: 1\ndata: {"type":"thinking","delta":"Thinking live"}\n\n',
                    ),
                  );
                } else controller.error(new TypeError("Network error"));
              },
            }),
          );
        },
      );
      const events: AgentStreamEvent[] = [];
      let state = createWorkspaceChatState("browser");
      await streamWorkspaceChat(
        p.id,
        { version: p.version, message: "Build it", modelId: "test" },
        (event) => {
          events.push(event);
          state = reduceWorkspaceChat(state, event);
        },
        new AbortController().signal,
      );
      assert.equal(calls, 1);
      if (lostInitialResponse)
        assert.equal(
          requests.filter((url) => url.startsWith("POST")).length,
          2,
        );
      else assert.ok(requests.some((url) => url.includes("after=1")));
      assert.equal(
        events.filter((event) => event.type === "thinking").length,
        1,
      );
      assert.ok(
        events.some(
          (event) =>
            event.type === "connection" && event.status === "reconnecting",
        ),
      );
      assert.equal(state.message.thinking, "Thinking live");
      assert.equal(state.message.text, "Finished");
      assert.equal(state.message.tools?.[0].status, "done");
    },
  );

test("new workspaces start empty with an optional name", async (t) => {
  const { request } = await fixture(t);
  for (const name of [undefined, "  My app  "]) {
    const response = await request("", "POST", { name });
    assert.equal(response.status, 201);
    const project = await response.json() as any;
    assert.equal(project.installed, false);
    assert.deepEqual(project.messages, []);
    assert.deepEqual(Object.keys(project.files), ["manifest.json"]);
    const manifest = JSON.parse(project.files["manifest.json"]);
    assert.equal(manifest.app.id, project.id);
    assert.equal(manifest.app.name, name ? "My app" : "Untitled app");
    assert.deepEqual(manifest.entities, []);
    assert.deepEqual(manifest.tools, []);
    assert.deepEqual(
      ((await (await request(`/${project.id}`)).json()) as any).files,
      project.files,
    );
  }
});

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
