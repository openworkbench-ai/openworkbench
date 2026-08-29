export interface AgentBackend {
  prompt(text: string, onTextDelta: (delta: string) => void): Promise<void>;
}
