import {
  AUTH_REQUIRED_EVENT,
  type AgentStreamEvent,
  type ModelInfo,
} from "./api.js";

export type SourceFiles = Record<string, string>;
import type { WorkspaceMessage } from "../../../../packages/workspace-chat.js";
export type { WorkspaceMessage } from "../../../../packages/workspace-chat.js";
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
  activeRunId?: string;
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
export const createWorkspace = (name: string) =>
  request<WorkspaceProject>("", "POST", { name });
export const saveWorkspace = (
  id: string,
  version: number,
  files: Record<string, string | null>,
) => request<WorkspaceProject>(`/${id}`, "PATCH", { version, files });
export const clearWorkspaceChat = (id: string, version: number) =>
  request<WorkspaceProject>(`/${id}/chat`, "DELETE", { version });
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
  resumeRunId?: string,
) {
  const runId = resumeRunId ?? crypto.randomUUID();
  const path = `/api/workspaces/${id}/chat`;
  let started = !!resumeRunId;
  let lastSequence = 0;
  let retries = 0;
  const stop = () => {
    if (signal.reason === "disconnect") return;
    void fetch(`/api/workspaces/${id}/chat-stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
      keepalive: true,
    }).catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    for (;;) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let permanentError = false;
      const connection = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout>;
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => connection.abort(), 45000);
      };
      resetIdle();
      try {
        const res = await fetch(
          started ? `${path}?runId=${runId}&after=${lastSequence}` : path,
          {
            method: started ? "GET" : "POST",
            headers: { "Content-Type": "application/json" },
            body: started ? undefined : JSON.stringify({ ...body, runId }),
            signal: AbortSignal.any([signal, connection.signal]),
          },
        );
        if (!res.ok || !res.body) {
          if (res.status === 401)
            window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
          permanentError = ![408, 429, 500, 502, 503, 504].includes(res.status);
          const error = await res.json().catch(() => ({}));
          throw new Error(
            error.error ??
              `Could not reach the coding partner (${res.status}).`,
          );
        }
        started = true;
        onEvent({ type: "connection", status: "connected" });
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          resetIdle();
          if (done)
            throw new Error(
              "The coding partner connection ended unexpectedly.",
            );
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = chunk.split("\n");
            const data = lines.find((line) => line.startsWith("data: "));
            if (!data) continue; // SSE comments are transport keepalives.
            const sequence = Number(
              lines.find((line) => line.startsWith("id: "))?.slice(4),
            );
            if (!Number.isSafeInteger(sequence) || sequence < 1) {
              permanentError = true;
              throw new Error("Invalid coding partner stream event.");
            }
            if (sequence <= lastSequence) continue;
            const event = JSON.parse(data.slice(6)) as AgentStreamEvent;
            onEvent(event);
            lastSequence = sequence;
            retries = 0;
            if (event.type === "done") return;
          }
        }
      } catch (error) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (permanentError) throw error;
        if (++retries > 5)
          throw new Error(
            "Connection lost after 5 reconnect attempts. Your coding partner may still be working. Reload to see saved progress.",
          );
        onEvent({
          type: "connection",
          status: "reconnecting",
          attempt: retries,
        });
      } finally {
        clearTimeout(idleTimer!);
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      await reconnectDelay(Math.min(1000 * 2 ** (retries - 1), 8000), signal);
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

function reconnectDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
