import {
  AUTH_REQUIRED_EVENT,
  type AgentStreamEvent,
  type ModelInfo,
} from "./api";

export type SourceFiles = Record<string, string>;
export interface WorkspaceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  tools?: { name: string; path?: string; error?: boolean }[];
  error?: string;
}
export interface WorkspaceRevision {
  id: string;
  number: number;
  at: string;
  message: string;
  files: SourceFiles;
}
export interface WorkspaceProject {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  installed: boolean;
  files: SourceFiles;
  baseFiles: SourceFiles;
  revisions: WorkspaceRevision[];
  messages: WorkspaceMessage[];
  authors: Record<string, "you" | "agent">;
  changes: { path: string; kind: string; author: string }[];
  busy: boolean;
  agent: { available: boolean; model: string; models: ModelInfo[] };
}
export interface WorkspaceProblem {
  path: string;
  message: string;
  line?: number;
}
export interface WorkspaceValidation {
  valid: boolean;
  version: number;
  problems: WorkspaceProblem[];
  migration?: { kind: string; description: string; destructive: boolean }[];
  permissions?: { network: string[] | null; model: boolean; data: string[] };
  requiresConfirmation?: boolean;
}

async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api/workspaces${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await res.json();
  if (!res.ok) {
    if (res.status === 401)
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : (result.error?.message ?? "Workspace request failed."),
    );
  }
  return result;
}
export const fetchWorkspace = (id: string) =>
  request<WorkspaceProject>(`/${id}`);
export const createWorkspace = (name: string, template: string) =>
  request<WorkspaceProject>("", "POST", { name, template });
export const saveWorkspace = (
  id: string,
  version: number,
  files: Record<string, string | null>,
) => request<WorkspaceProject>(`/${id}`, "PATCH", { version, files });
export const restoreWorkspace = (
  id: string,
  version: number,
  revisionId?: string,
) =>
  request<WorkspaceProject>(`/${id}/restore`, "POST", { version, revisionId });
export const validateWorkspace = (id: string, version: number) =>
  request<WorkspaceValidation>(`/${id}/validate`, "POST", { version });
export const applyWorkspace = (
  id: string,
  version: number,
  message: string,
  confirm: boolean,
) =>
  request<WorkspaceProject>(`/${id}/apply`, "POST", {
    version,
    message,
    confirm,
  });
export const previewWorkspace = (
  id: string,
  version: number,
  component: string,
) =>
  request<{ html: string; version: number }>(`/${id}/preview`, "POST", {
    version,
    component,
  });

export async function streamWorkspaceChat(
  id: string,
  body: {
    version: number;
    message: string;
    selectedFile?: string;
    modelId: string;
  },
  onEvent: (event: AgentStreamEvent) => void,
  signal: AbortSignal,
) {
  const res = await fetch(`/api/workspaces/${id}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error ?? "Could not reach the workspace agent.");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of chunk.split("\n"))
        if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
    }
  }
}
