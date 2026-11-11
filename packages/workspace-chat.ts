/** Wire events shared by the runtime and browser. */
export type AgentStreamEvent =
  | { type: "text" | "thinking"; delta: string }
  | { type: "assistant_start" }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  | { type: "retry_end"; success: boolean }
  | {
      type: "connection";
      status: "connected" | "reconnecting";
      attempt?: number;
    }
  | {
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      delta?: string;
    }
  | {
      type: "tool_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      resourceUri?: string;
      appId?: string;
    }
  | { type: "error"; reason: string }
  | { type: "done" };

export interface WorkspaceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  /** Ordered activity for live rendering and reloads. Absent on older transcripts. */
  segments?: WorkspaceMessageSegment[];
  at: string;
  tools?: {
    toolCallId?: string;
    name: string;
    path?: string;
    args?: string;
    result?: string;
    status?: "preparing" | "running" | "done" | "interrupted";
    error?: boolean;
    startedAt?: number;
    durationMs?: number;
  }[];
  error?: string;
}

export type WorkspaceMessageSegment =
  | { kind: "text"; text: string }
  | {
      kind: "thinking";
      text: string;
      streaming: boolean;
      startedAt?: number;
      durationMs?: number;
    }
  | { kind: "tool"; toolIndex: number };

/** Old transcripts retain their content, but their original ordering was not saved. */
export function workspaceMessageSegments(message: WorkspaceMessage): WorkspaceMessageSegment[] {
  if (message.segments) return message.segments;
  const segments: WorkspaceMessageSegment[] = [];
  if (message.thinking)
    segments.push({ kind: "thinking", text: message.thinking, streaming: false });
  if (message.text) segments.push({ kind: "text", text: message.text });
  message.tools?.forEach((_, toolIndex) => segments.push({ kind: "tool", toolIndex }));
  return segments;
}

export interface WorkspaceChatState {
  message: WorkspaceMessage;
  retry?: Extract<AgentStreamEvent, { type: "retry" }>;
  connection?: Extract<AgentStreamEvent, { type: "connection" }>;
  turnTextStart: number;
  turnThinkingStart: number;
  turnToolsStart: number;
  turnSegmentsStart: number;
}

export function createWorkspaceChatState(id: string): WorkspaceChatState {
  return {
    message: {
      id,
      role: "assistant",
      text: "",
      thinking: "",
      at: new Date().toISOString(),
      tools: [],
      segments: [],
    },
    turnTextStart: 0,
    turnThinkingStart: 0,
    turnToolsStart: 0,
    turnSegmentsStart: 0,
  };
}

function closeThinking(segments: WorkspaceMessageSegment[], now: number) {
  return segments.map((segment) =>
    segment.kind === "thinking" && segment.streaming
      ? {
          ...segment,
          streaming: false,
          durationMs: segment.startedAt === undefined ? undefined : now - segment.startedAt,
        }
      : segment,
  );
}

function appendContent(
  segments: WorkspaceMessageSegment[],
  kind: "text" | "thinking",
  delta: string,
  turnStart: number,
  now: number,
): WorkspaceMessageSegment[] {
  const last = segments.at(-1);
  if (
    segments.length > turnStart && last?.kind === kind &&
    (last.kind !== "thinking" || last.streaming)
  ) {
    return [...segments.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [
    ...segments,
    kind === "thinking"
      ? { kind, text: delta, streaming: true, startedAt: now }
      : { kind, text: delta },
  ];
}

function preview(value: unknown): string {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  return text.length > 12000 ? `${text.slice(0, 12000)}\n… (truncated)` : text;
}

/** One reducer keeps the persisted transcript and live UI consistent, including retries. */
export function reduceWorkspaceChat(
  state: WorkspaceChatState,
  event: AgentStreamEvent,
): WorkspaceChatState {
  const message = { ...state.message };
  const next = { ...state, message };
  const now = Date.now();
  const segments = message.segments ?? [];
  switch (event.type) {
    case "connection":
      next.connection = event;
      break;
    case "assistant_start":
      message.segments = closeThinking(segments, now);
      next.turnSegmentsStart = segments.length;
      next.turnTextStart = message.text.length;
      next.turnThinkingStart = message.thinking?.length ?? 0;
      next.turnToolsStart = message.tools?.length ?? 0;
      break;
    case "text":
      message.text += event.delta;
      message.segments = appendContent(
        closeThinking(segments, now), "text", event.delta, state.turnSegmentsStart, now,
      );
      next.retry = undefined;
      break;
    case "thinking":
      message.thinking = (message.thinking ?? "") + event.delta;
      message.segments = appendContent(
        segments, "thinking", event.delta, state.turnSegmentsStart, now,
      );
      next.retry = undefined;
      break;
    case "retry":
      next.retry = event;
      // The SDK re-requests only the failed assistant turn; don't duplicate its partial output.
      message.text = message.text.slice(0, state.turnTextStart);
      message.thinking = message.thinking?.slice(0, state.turnThinkingStart);
      message.tools = message.tools?.slice(0, state.turnToolsStart);
      message.segments = segments.slice(0, state.turnSegmentsStart);
      break;
    case "retry_end":
      next.retry = undefined;
      break;
    case "tool_call":
    case "tool_start": {
      next.retry = undefined;
      const tools = [...(message.tools ?? [])];
      const index = tools.findIndex(
        (tool) => tool.toolCallId === event.toolCallId,
      );
      const tool = {
        toolCallId: event.toolCallId,
        name: event.toolName,
        path:
          typeof (event.args as { path?: unknown })?.path === "string"
            ? (event.args as { path: string }).path
            : tools[index]?.path,
        args:
          event.type === "tool_call" && event.delta !== undefined
            ? preview((tools[index]?.args ?? "").slice(0, 12000) + event.delta)
            : preview(event.args),
        status:
          event.type === "tool_call"
            ? ("preparing" as const)
            : ("running" as const),
        startedAt: event.type === "tool_start" ? (tools[index]?.startedAt ?? now) : tools[index]?.startedAt,
      };
      if (index === -1) tools.push(tool);
      else tools[index] = { ...tools[index], ...tool };
      message.tools = tools;
      message.segments = closeThinking(segments, now);
      if (index === -1)
        message.segments.push({ kind: "tool", toolIndex: tools.length - 1 });
      break;
    }
    case "tool_end":
      message.segments = closeThinking(segments, now);
      message.tools = message.tools?.map((tool) =>
        tool.toolCallId === event.toolCallId
          ? {
              ...tool,
              status: "done",
              error: event.isError,
              result: preview(event.result),
              durationMs: tool.startedAt === undefined ? undefined : now - tool.startedAt,
            }
          : tool,
      );
      break;
    case "error":
      message.error = event.reason;
      message.segments = closeThinking(segments, now);
      next.retry = undefined;
      break;
    case "done":
      next.retry = undefined;
      message.segments = closeThinking(segments, now);
      message.tools = message.tools?.map((tool) =>
        tool.status === "running" || tool.status === "preparing"
          ? {
              ...tool,
              status: "interrupted",
              durationMs: tool.startedAt === undefined ? undefined : now - tool.startedAt,
            }
          : tool,
      );
      break;
  }
  return next;
}
