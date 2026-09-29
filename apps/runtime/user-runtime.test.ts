import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackend } from "./agent-backend.js";
import type { Capabilities } from "./app-loader.js";
import { createUserRuntimes } from "./user-runtime.js";

function fakeBackend(modelId: string): AgentBackend & { disposed: boolean } {
  return {
    disposed: false,
    async prompt() {},
    async setModel() {},
    getModelId: () => modelId,
    async dispose() {
      this.disposed = true;
    },
  };
}

function setup(now: () => number = () => 0) {
  const created: { kind: "chat" | "build"; caps?: Capabilities; backend: ReturnType<typeof fakeBackend> }[] = [];
  const visible: Record<string, string[]> = { ada: ["notes"], bob: ["tracker"] };
  const runtimes = createUserRuntimes(
    {
      async createChat(caps, modelId = "default") {
        const backend = fakeBackend(modelId);
        created.push({ kind: "chat", caps, backend });
        return backend;
      },
      async createBuild() {
        const backend = fakeBackend("default");
        created.push({ kind: "build", backend });
        return backend;
      },
      capabilitiesFor: (userId) => ({
        skillPaths: [],
        mcpServers: visible[userId].map((name) => ({ name, url: `http://engine/mcp/${name}` })),
      }),
    },
    { idleMs: 1000, now }
  );
  return { runtimes, created };
}

test("gives each user their own agents over only their own apps", async () => {
  const { runtimes, created } = setup();
  const ada = runtimes.forUser("ada");
  const bob = runtimes.forUser("bob");

  assert.notEqual(await ada.chat(), await bob.chat());
  assert.equal(await ada.chat(), await ada.chat(), "a user's agent is reused across calls");
  assert.deepEqual(created[0].caps?.mcpServers.map((s) => s.name), ["notes"]);
  assert.deepEqual(created[1].caps?.mcpServers.map((s) => s.name), ["tracker"]);
  assert.notEqual(await ada.build(), await bob.build());
  await runtimes.disposeAll();
});

test("streaming flags are per user", async () => {
  const { runtimes } = setup();
  runtimes.forUser("ada").streaming = true;
  assert.equal(runtimes.forUser("bob").streaming, false);
  await runtimes.disposeAll();
});

test("refreshChat rebuilds over current apps but keeps the model, and refuses mid-response", async () => {
  const { runtimes, created } = setup();
  const ada = runtimes.forUser("ada");
  assert.equal(await ada.refreshChat(), true);
  assert.equal(created.length, 0, "nothing to refresh before the agent exists");

  const first = await ada.chat();
  await first.setModel("other-model");
  const chatBackend = created[0].backend;
  chatBackend.getModelId = () => "other-model";

  assert.equal(await ada.refreshChat(), true);
  assert.equal(created.length, 2);
  assert.equal((await ada.chat()).getModelId(), "other-model");

  ada.streaming = true;
  assert.equal(await ada.refreshChat(), false);
  assert.equal(created.length, 2);
  await runtimes.disposeAll();
});

test("a failed agent creation is retried rather than cached", async () => {
  let attempts = 0;
  const runtimes = createUserRuntimes({
    async createChat() {
      if (++attempts === 1) throw new Error("boom");
      return fakeBackend("default");
    },
    createBuild: async () => fakeBackend("default"),
    capabilitiesFor: () => ({ skillPaths: [], mcpServers: [] }),
  });
  const ada = runtimes.forUser("ada");
  await assert.rejects(ada.chat(), /boom/);
  assert.equal((await ada.chat()).getModelId(), "default");
  await runtimes.disposeAll();
});

test("disposeAll releases every user's agents", async () => {
  const { runtimes, created } = setup();
  await runtimes.forUser("ada").chat();
  await runtimes.forUser("bob").build();
  await runtimes.disposeAll();
  assert.ok(created.every((c) => c.backend.disposed));
});
