import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createAgentSession,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { createWorkspaceStore } from "./workspace-store.js";
import { starterFiles } from "./workspace-service.js";
import { runWorkspaceAgent } from "./workspace-agent.js";
import type { PreparedAttachment } from "../../packages/chat-attachments.js";
import {
  createWorkspaceChatState,
  reduceWorkspaceChat,
  type AgentStreamEvent,
} from "../../packages/workspace-chat.js";

type Update = Extract<
  AgentSessionEvent,
  { type: "message_update" }
>["assistantMessageEvent"];
type AssistantMessage = Extract<Update, { type: "text_delta" }>["partial"];
type StreamFunction = AgentSession["agent"]["streamFunction"];

function reply(
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"] = [],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "openrouter",
    model: "test",
    timestamp: Date.now(),
    content,
    stopReason,
    errorMessage,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

async function runScript(
  t: TestContext,
  script: (attempt: number) => { message: AssistantMessage; events?: Update[] },
  modelId = "auto",
  attachments: PreparedAttachment[] = [],
  previousAttachments: PreparedAttachment[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), "workspace-agent-stream-test-"));
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  });
  const store = createWorkspaceStore(root);
  store.create("alice", "demo", starterFiles("demo", "Demo"));
  if (previousAttachments.length) store.addMessage("alice", "demo", { id: "previous", role: "user", text: "Reference for later", at: new Date().toISOString(), attachments: previousAttachments });
  let requests = 0;
  const inputs: Parameters<StreamFunction>[1][] = [];
  const events: AgentStreamEvent[] = [];
  const promise = runWorkspaceAgent(
    {
      store,
      userId: "alice",
      id: "demo",
      engineUrl: "http://unused",
      modelId,
      attachments,
      message: "Inspect my app",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    },
    {
      async createAgentSession(options) {
        assert.equal(options?.model?.id, modelId === "auto" ? "openai/gpt-6.1-sol" : modelId);
        assert.equal(options?.thinkingLevel, modelId === "z-ai/glm-5.3-flash" ? "low" : "medium");
        assert.deepEqual(options?.settingsManager?.getRetrySettings(), {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 2000,
        });
        const result = await createAgentSession({
          ...options,
          settingsManager: SettingsManager.inMemory({
            retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
          }),
        });
        const stream: StreamFunction = (_model, context) => {
          inputs.push(context);
          const response = script(++requests);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "start", partial: response.message } as Update;
              for (const event of response.events ?? []) yield event;
              yield response.message.stopReason === "error"
                ? ({
                    type: "error",
                    reason: "error",
                    error: response.message,
                  } as Update)
                : ({
                    type: "done",
                    reason: response.message.stopReason,
                    message: response.message,
                  } as Update);
            },
            result: async () => response.message,
          } as unknown as ReturnType<StreamFunction>;
        };
        result.session.agent.streamFunction = stream;
        return result;
      },
    },
  );
  return { promise, events, inputs, requests: () => requests };
}

test("real Pi session streams thinking and tool arguments, retries the failed turn and executes the tool once", async (t) => {
  const tool = {
    type: "toolCall" as const,
    id: "read-1",
    name: "read_file",
    arguments: { path: "manifest.json" },
  };
  const run = await runScript(t, (attempt) => {
    if (attempt === 1) {
      const message = reply(
        "error",
        [{ type: "text", text: "Incomplete answer" }],
        "Network error",
      );
      return {
        message,
        events: [
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "Incomplete answer",
            partial: message,
          },
        ],
      };
    }
    if (attempt === 2) {
      const message = reply("toolUse", [
        { type: "thinking", thinking: "Inspecting the manifest" },
        tool,
      ]);
      return {
        message,
        events: [
          {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Inspecting the manifest",
            partial: message,
          },
          {
            type: "toolcall_delta",
            contentIndex: 1,
            delta: '{"path":"manifest.json"}',
            partial: message,
          },
        ],
      };
    }
    const message = reply("stop", [
      { type: "text", text: "The app is ready to edit." },
    ]);
    return {
      message,
      events: [
        {
          type: "text_delta",
          contentIndex: 0,
          delta: "The app is ready to edit.",
          partial: message,
        },
      ],
    };
  });
  await run.promise;
  assert.equal(run.requests(), 3);
  assert.ok(
    run.events.some((event) => event.type === "retry" && event.attempt === 1),
  );
  const draft = run.events.findIndex((event) => event.type === "tool_call");
  const execution = run.events.findIndex(
    (event) => event.type === "tool_start",
  );
  assert.ok(draft >= 0 && execution > draft);
  assert.equal(
    run.events.filter((event) => event.type === "tool_start").length,
    1,
  );
  const state = run.events.reduce(
    reduceWorkspaceChat,
    createWorkspaceChatState("result"),
  );
  assert.equal(state.message.text, "The app is ready to edit.");
  assert.equal(state.message.thinking, "Inspecting the manifest");
  assert.equal(state.message.tools?.[0].status, "done");
  const toolResult = JSON.parse(state.message.tools![0].result!);
  assert.equal(JSON.parse(toolResult.content[0].text).app.id, "demo");
});

test("exhausted network retries are surfaced as a failure instead of a false Done", async (t) => {
  const run = await runScript(t, () => ({
    message: reply("error", [], "Network error"),
  }));
  await assert.rejects(run.promise, /Network error/);
  assert.equal(run.requests(), 4);
  assert.equal(run.events.filter((event) => event.type === "retry").length, 3);
});

test("manual workspace model choices reach the SDK without Auto overriding them", async (t) => {
  for (const modelId of ["z-ai/glm-5.3-flash", "minimax/minimax-m3.1-flash", "anthropic/claude-opus-5.5"]) {
    const run = await runScript(t, () => ({
      message: reply("stop", [{ type: "text", text: "Selected model is ready." }]),
    }), modelId);
    await run.promise;
    assert.equal(run.requests(), 1);
  }
});

test("workspace passes documents and photo bytes to the actual Pi session and retains earlier document context", async (t) => {
  const photo = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg1sAAAAASUVORK5CYII=" };
  const run = await runScript(t, () => ({ message: reply("stop", [{ type: "text", text: "Read the uploaded brief." }]) }), "auto", [
    { name: "brief.txt", mimeType: "text/plain", size: 20, text: "ATTACHED_BRIEF_MARKER" },
    { name: "photo.png", mimeType: "image/png", size: 68, image: photo },
  ], [{ name: "earlier.md", mimeType: "text/markdown", size: 20, text: "EARLIER_DOCUMENT_MARKER" }]);
  await run.promise;
  const user = run.inputs[0].messages.find((message) => message.role === "user");
  assert.ok(user);
  assert.match(JSON.stringify(user.content), /ATTACHED_BRIEF_MARKER/);
  assert.match(JSON.stringify(user.content), /EARLIER_DOCUMENT_MARKER/);
  assert.ok(Array.isArray(user.content));
  assert.ok(user.content.some((block) => block.type === "image" && block.data === photo.data));
});

test("permanent provider errors fail immediately", async (t) => {
  const run = await runScript(t, () => ({
    message: reply("error", [], "401 Invalid API key"),
  }));
  await assert.rejects(run.promise, /401 Invalid API key/);
  assert.equal(run.requests(), 1);
  assert.equal(run.events.filter((event) => event.type === "retry").length, 0);
});
