export type AgentStreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      /** MCP Apps `_meta.ui.resourceUri`, when this call's tool declared one (see extractUiResource). */
      resourceUri?: string;
      /** Which installed app's MCP server resourceUri belongs to -- needed to fetch it. */
      appId?: string;
    };

/**
 * Pulls the MCP Apps `_meta.ui.resourceUri` (and originating app id) off a
 * tool's result, when mcp-tools.ts's `callTool` attached one -- the signal
 * both backends use to populate `tool_end`'s `resourceUri`/`appId` so the
 * frontend can render a widget instead of a generic tool-call card. Returns
 * `{}` for every other tool (native file tools, ask_questions, etc).
 */
export function extractUiResource(result: unknown): { resourceUri?: string; appId?: string } {
  if (!result || typeof result !== "object") return {};
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return {};
  const d = details as { uiResourceUri?: unknown; server?: unknown };
  return {
    resourceUri: typeof d.uiResourceUri === "string" ? d.uiResourceUri : undefined,
    appId: typeof d.server === "string" ? d.server : undefined,
  };
}

/** A build agent's in-progress draft, read straight off its scratch workspace for the review card. */
export interface AppDraft {
  id: string;
  app: { id: string; name: string; description?: string; emoji?: string; color?: string; version?: number };
  entities: unknown[];
  tools: unknown[];
  skills: string[];
  data: { entity: string; count: number }[];
}

export type InstallResult = { ok: true; message: string } | { ok: false; status: number; message: string };

export interface AgentBackend {
  prompt(text: string, onEvent: (event: AgentStreamEvent) => void): Promise<void>;
  setModel(modelId: string): Promise<void>;
  getModelId(): string;
  /** Releases any resources this backend owns (e.g. a scratch workspace directory). Optional — most backends need none. */
  dispose?(): Promise<void>;
  /**
   * Resolves a pending human-in-the-loop tool call (e.g. a build agent's
   * `ask_questions`) with the caller's answer, letting that tool's
   * `execute` return and the in-flight `prompt()` continue. Returns false
   * if no call with that id is currently pending. Optional — only backends
   * with such tools implement it.
   */
  respondToTool?(toolCallId: string, value: unknown): boolean;
  /** Reads a build agent's drafted app off its scratch workspace, for the review card. Returns null if not found. */
  readDraft?(id: string): AppDraft | null;
  /** Saves and installs a build agent's drafted app — the user-initiated "Install" action, never called by the agent itself. */
  installDraft?(id: string): Promise<InstallResult>;
}
