export type AgentStreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean };

export interface AgentBackend {
  prompt(text: string, onEvent: (event: AgentStreamEvent) => void): Promise<void>;
  setModel(modelId: string): Promise<void>;
  getModelId(): string;
}
