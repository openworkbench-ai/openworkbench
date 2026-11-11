import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorkspaceChatState,
  reduceWorkspaceChat,
  workspaceMessageSegments,
  type AgentStreamEvent,
} from "../../packages/workspace-chat.js";
import { groupSegments } from "../web/src/lib/chat-segments.js";

const startTool = (id: string): AgentStreamEvent => ({
  type: "tool_start", toolCallId: id, toolName: "read_file", args: { path: "manifest.json" },
});
const endTool = (id: string): AgentStreamEvent => ({
  type: "tool_end", toolCallId: id, toolName: "read_file", result: "File contents", isError: false,
});

test("thinking, output and tools retain their order, with only adjacent tools grouped", (t) => {
  let clock = 1000;
  t.mock.method(Date, "now", () => clock += 100);
  const events: AgentStreamEvent[] = [
    { type: "assistant_start" },
    { type: "thinking", delta: "First " },
    { type: "thinking", delta: "thought" },
    { type: "text", delta: "I'll read the manifest." },
    { type: "tool_call", toolCallId: "one", toolName: "read_file", delta: '{"path":' },
    { type: "tool_call", toolCallId: "one", toolName: "read_file", delta: '"manifest.json"}' },
    startTool("one"), endTool("one"),
    { type: "assistant_start" },
    { type: "thinking", delta: "Second thought" },
    { type: "text", delta: "Now I'll read the other files." },
    startTool("two"), endTool("two"), startTool("three"), endTool("three"),
    { type: "assistant_start" },
    { type: "thinking", delta: "Final thought" },
    { type: "text", delta: "Here is my suggestion." },
    { type: "done" },
  ];
  const state = events.reduce(reduceWorkspaceChat, createWorkspaceChatState("ordered"));
  const segments = state.message.segments!;
  assert.deepEqual(segments.map(s => s.kind), [
    "thinking", "text", "tool", "thinking", "text", "tool", "tool", "thinking", "text",
  ]);
  assert.equal(segments[0].kind === "thinking" && segments[0].text, "First thought");
  for (const segment of segments) {
    if (segment.kind === "thinking") {
      assert.equal(segment.streaming, false);
      assert.ok(segment.durationMs! > 0);
    }
  }
  assert.equal(state.message.tools?.length, 3, "argument streaming does not duplicate calls");
  assert.ok(state.message.tools!.every(tool => tool.status === "done" && tool.durationMs! > 0));
  assert.deepEqual(
    groupSegments(segments).map(item => item.kind === "single" ? item.segment.kind : `tools:${item.items.length}`),
    ["thinking", "text", "tools:1", "thinking", "text", "tools:2", "thinking", "text"],
  );
  const restored = JSON.parse(JSON.stringify(state.message));
  assert.deepEqual(workspaceMessageSegments(restored), segments, "ordering survives serialization");
});

test("only the current thinking block stays live and completion seals interrupted tools", () => {
  let state = createWorkspaceChatState("live");
  state = reduceWorkspaceChat(state, { type: "thinking", delta: "First thought" });
  const first = state;
  state = reduceWorkspaceChat(state, startTool("one"));
  assert.equal(state.message.segments?.[0].kind === "thinking" && state.message.segments[0].streaming, false);
  assert.equal(first.message.segments?.[0].kind === "thinking" && first.message.segments[0].streaming, true, "prior state is immutable");
  state = reduceWorkspaceChat(state, { type: "thinking", delta: "Next thought" });
  assert.equal(state.message.segments?.at(-1)?.kind, "thinking");
  state = reduceWorkspaceChat(state, { type: "done" });
  assert.ok(state.message.segments?.every(segment => segment.kind !== "thinking" || !segment.streaming));
  assert.equal(state.message.tools?.[0].status, "interrupted");
});

test("retry removes only the failed turn's segments and reuses valid tool indexes", () => {
  const events: AgentStreamEvent[] = [
    { type: "assistant_start" },
    { type: "thinking", delta: "Keep this thought" },
    { type: "text", delta: "Keep this output" },
    startTool("keep"), endTool("keep"),
    { type: "assistant_start" },
    { type: "thinking", delta: "Discard this thought" },
    { type: "text", delta: "Discard this output" },
    { type: "tool_call", toolCallId: "discard", toolName: "read_file", delta: "{" },
    { type: "retry", attempt: 1, maxAttempts: 3, delayMs: 1, reason: "Network error" },
    { type: "retry_end", success: true },
    { type: "assistant_start" },
    { type: "text", delta: "Replacement" },
    startTool("replacement"), endTool("replacement"),
    { type: "done" },
  ];
  const state = events.reduce(reduceWorkspaceChat, createWorkspaceChatState("retry"));
  assert.deepEqual(state.message.segments?.map(s => s.kind), ["thinking", "text", "tool", "text", "tool"]);
  assert.deepEqual(state.message.tools?.map(tool => tool.toolCallId), ["keep", "replacement"]);
  assert.deepEqual(state.message.segments?.filter(s => s.kind === "tool").map(s => s.toolIndex), [0, 1]);
  assert.ok(!JSON.stringify(state.message).includes("Discard"));

  const textOnly = [
    { type: "text", delta: "Keep" }, { type: "assistant_start" },
    { type: "text", delta: "Discard" },
    { type: "retry", attempt: 1, maxAttempts: 3, delayMs: 1, reason: "Network error" },
  ] satisfies AgentStreamEvent[];
  const rolledBack = textOnly.reduce(reduceWorkspaceChat, createWorkspaceChatState("text-retry"));
  assert.deepEqual(rolledBack.message.segments, [{ kind: "text", text: "Keep" }]);
});

test("legacy transcripts remain readable without inventing missing chronology", () => {
  const message = { id: "old", role: "assistant" as const, text: "Answer", thinking: "Thought", at: "", tools: [{ name: "read_file" }] };
  assert.deepEqual(workspaceMessageSegments(message), [
    { kind: "thinking", text: "Thought", streaming: false },
    { kind: "text", text: "Answer" },
    { kind: "tool", toolIndex: 0 },
  ]);
});
