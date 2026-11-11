import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Code2,
  FileCode2,
  LoaderCircle,
  MessageSquare,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { CodeBlock } from "@/components/ui/code-block";
import { Markdown } from "@/components/ui/markdown";
import { Thinking } from "@/components/ui/thinking";
import { StreamingCaret } from "@/components/ui/streaming";
import {
  ToolCall,
  ToolCallArgs,
  ToolCallPanel,
  type ToolStatus,
} from "@/components/ui/tool-call";
import type { WorkspaceMessage, WorkspaceProject } from "@/lib/workspace-api";
import {
  workspaceMessageSegments,
  type WorkspaceChatState,
} from "../../../../../packages/workspace-chat";
import { groupSegments } from "@/lib/chat-segments";
import { fileLabel } from "@/lib/workspace-model";

const USER_MESSAGE_PREVIEW_LENGTH = 300;

type WorkspaceTool = NonNullable<WorkspaceMessage["tools"]>[number];

function toolStatus(tool: WorkspaceTool): ToolStatus {
  if (tool.status === "preparing") return "pending";
  if (tool.status === "running") return "running";
  if (tool.status === "interrupted") return "interrupted";
  return tool.error ? "error" : "success";
}

function WorkspaceToolArguments({ value }: { value: string }) {
  // Streaming arguments and truncated previews may not yet be valid JSON.
  let args: unknown;
  try {
    args = JSON.parse(value);
  } catch {
    return <CodeBlock code={value} language="text" />;
  }
  return args && typeof args === "object" && !Array.isArray(args) ? (
    <ToolCallArgs args={args as Record<string, unknown>} />
  ) : (
    <CodeBlock code={value} language="json" />
  );
}

function WorkspaceToolCall({
  tool,
  openFile,
}: {
  tool: WorkspaceTool;
  openFile: (path: string) => void;
}) {
  return (
    <ToolCall
      name={tool.name}
      status={toolStatus(tool)}
      duration={tool.durationMs != null ? `${(tool.durationMs / 1000).toFixed(1)}s` : undefined}
    >
      {tool.path && (
        <button
          type="button"
          className="w-fit text-xs text-accent underline underline-offset-4"
          onClick={() => openFile(tool.path!)}
        >
          {fileLabel(tool.path)}
        </button>
      )}
      {tool.args && (
        <ToolCallPanel label="Arguments">
          <WorkspaceToolArguments value={tool.args} />
        </ToolCallPanel>
      )}
      {tool.result && (
        <ToolCallPanel label="Result">
          <CodeBlock code={tool.result} language="text" />
        </ToolCallPanel>
      )}
    </ToolCall>
  );
}

function WorkspaceToolActivity({
  tools,
  openFile,
}: {
  tools: WorkspaceTool[];
  openFile: (path: string) => void;
}) {
  if (tools.length === 0) return null;
  if (tools.length === 1) {
    return (
      <div className="mt-3">
        <WorkspaceToolCall tool={tools[0]} openFile={openFile} />
      </div>
    );
  }

  const names = new Set(tools.map((tool) => tool.name));
  const statuses = tools.map(toolStatus);
  const status =
    statuses.includes("running") ? "running" :
    statuses.includes("pending") ? "pending" :
    statuses.includes("error") ? "error" :
    statuses.includes("interrupted") ? "interrupted" : "success";
  const first = tools[0];
  const last = tools[tools.length - 1];
  const duration = tools.every(tool => tool.startedAt != null && tool.durationMs != null)
    ? `${((last.startedAt! + last.durationMs! - first.startedAt!) / 1000).toFixed(1)}s`
    : undefined;
  return (
    <ToolCall
      className="mt-3"
      name={names.size === 1 ? `${tools.length} × ${tools[0].name}` : `${tools.length} tool calls`}
      status={status}
      duration={duration}
    >
      <ToolCallPanel label={`${tools.length} calls`}>
        <div className="flex min-w-0 flex-col gap-2">
          {tools.map((tool, index) => (
            <WorkspaceToolCall
              key={tool.toolCallId ?? index}
              tool={tool}
              openFile={openFile}
            />
          ))}
        </div>
      </ToolCallPanel>
    </ToolCall>
  );
}

function WorkspaceAssistantContent({
  item,
  live,
  openFile,
}: {
  item: WorkspaceMessage;
  live: boolean;
  openFile: (path: string) => void;
}) {
  return (
    <div className="space-y-3">
      {groupSegments(workspaceMessageSegments(item)).map((entry, index, all) => {
        if (entry.kind === "tool-group") {
          const tools = entry.items
            .map((segment) => item.tools?.[segment.toolIndex])
            .filter((tool): tool is WorkspaceTool => !!tool);
          return <WorkspaceToolActivity key={index} tools={tools} openFile={openFile} />;
        }
        const segment = entry.segment;
        if (segment.kind === "thinking") {
          return (
            <Thinking
              key={index}
              streaming={live && segment.streaming}
              duration={segment.durationMs != null ? Math.round(segment.durationMs / 1000) : undefined}
            >
              <Markdown content={segment.text} />
            </Thinking>
          );
        }
        return (
          <div key={index} className="workspace-message-body">
            <Markdown content={segment.text} />
            {live && index === all.length - 1 ? <StreamingCaret /> : null}
          </div>
        );
      })}
    </div>
  );
}

function WorkspaceAgentMessage({
  item,
  live = false,
  openFile,
}: {
  item: WorkspaceMessage;
  live?: boolean;
  openFile: (path: string) => void;
}) {
  return (
    <div className={`workspace-message message-${item.role}`}>
      <div className="message-byline">
        {item.role === "assistant" ? (
          <>
            <span className="agent-mini-mark">✻</span> WORKBENCH
          </>
        ) : (
          "YOU"
        )}
      </div>
      {item.role === "assistant" && (
        <WorkspaceAssistantContent item={item} live={live} openFile={openFile} />
      )}
      {item.role === "user" && item.text && (
        <div className="workspace-message-body">
          {item.role === "user" && item.text.length > USER_MESSAGE_PREVIEW_LENGTH ? (
            <details className="agent-user-message">
              <summary>
                <span className="agent-user-message-preview">
                  {item.text.slice(0, USER_MESSAGE_PREVIEW_LENGTH).trimEnd()}…
                </span>
                <span className="agent-user-message-toggle">
                  <ChevronDown size={12} aria-hidden="true" />
                  <span className="agent-user-message-more">Show more</span>
                  <span className="agent-user-message-less">Show less</span>
                </span>
              </summary>
              <Markdown content={item.text} />
            </details>
          ) : (
            <Markdown content={item.text} />
          )}
        </div>
      )}
      {item.error && (
        <div className="agent-error" role="alert">
          {item.error}
        </div>
      )}
    </div>
  );
}

export function WorkspaceAgentPanel({
  project,
  selectedFile,
  streaming,
  transient,
  retry,
  reconnecting,
  clearing,
  clearDisabled,
  onClear,
  onSend,
  onStop,
  onClose,
  openFile,
  initialPrompt,
  pendingMessage,
}: {
  project: WorkspaceProject;
  selectedFile?: string;
  streaming: boolean;
  transient?: WorkspaceMessage;
  retry?: WorkspaceChatState["retry"];
  reconnecting?: boolean;
  clearing: boolean;
  clearDisabled: boolean;
  onClear: () => void;
  onSend: (message: string, modelId: string) => void;
  onStop: () => void;
  onClose: () => void;
  openFile: (path: string) => void;
  initialPrompt?: { text: string; key: number };
  pendingMessage: string;
}) {
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(project.agent.model);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (initialPrompt) {
      setDraft(initialPrompt.text);
      input.current?.focus();
    }
  }, [initialPrompt]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [project.messages, transient, retry, reconnecting, streaming]);
  const submit = () => {
    if (!draft.trim() || streaming || clearing || !project.agent.available) return;
    onSend(draft.trim(), model);
    setDraft("");
  };
  const suggestions = selectedFile
    ? [
        {
          label: "Walk me through this file",
          text: `Explain ${selectedFile} and how it fits into this app.`,
        },
        {
          label: "Help me improve it",
          text: `Review ${selectedFile} and suggest a useful improvement. Explain your suggestion before changing it.`,
        },
      ]
    : [
        {
          label: "Explain how this app works",
          text: "Walk me through this app's data model, skills, tools, components and functions. Don't make changes yet.",
        },
        {
          label: "Make it more useful",
          text: "Look at this app and suggest one practical improvement. Explain it before making changes.",
        },
        {
          label: "Build something together",
          text: "I'd like to extend this app. Help me choose a useful next feature, then we'll build it together.",
        },
      ];
  return (
    <aside className="workspace-agent-panel" aria-label="App coding partner">
      <div className="agent-panel-header">
        <span>
          <Sparkles size={15} /> Coding partner
        </span>
        <div className="agent-panel-actions">
          <button
            type="button"
            className="subtle-button agent-clear-chat"
            onClick={onClear}
            disabled={clearDisabled || project.messages.length === 0}
            title="Clear this app's conversation"
          >
            {clearing ? (
              <LoaderCircle size={12} className="animate-spin" />
            ) : (
              <Trash2 size={12} />
            )}
            {clearing ? "Clearing…" : "Clear chat"}
          </button>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close agent panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="agent-context-strip">
        <span
          className={`status-dot ${project.agent.available ? "connected" : ""}`}
        />
        {streaming
          ? "Working in your draft"
          : project.agent.available
            ? "Connected to this app"
            : "Editor ready · agent offline"}
        <span className="context-shield">
          <Code2 size={12} /> APP SCOPED
        </span>
      </div>
      <div className="agent-transcript">
        {project.messages.length === 0 && !streaming ? (
          <div className="agent-welcome">
            <div className="agent-welcome-art">
              <span>✻</span>
              <i className="art-dot-one" />
              <i className="art-dot-two" />
            </div>
            <h2>Coding agent</h2>
            <p>Ask a question or describe a change to this app.</p>
            <div className="agent-suggestions">
              {suggestions.map((s) => (
                <button
                  key={s.label}
                  onClick={() => {
                    setDraft(s.text);
                    input.current?.focus();
                  }}
                >
                  <MessageSquare size={13} />
                  <span>{s.label}</span>
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
            <div className="agent-boundary-note">
              <p>Changes are saved to your draft until you apply them.</p>
            </div>
          </div>
        ) : (
          <>
            {project.messages.map((item) => (
              <WorkspaceAgentMessage
                key={item.id}
                item={item}
                openFile={openFile}
              />
            ))}
            {streaming &&
              pendingMessage &&
              !(project.messages.at(-1)?.role === "user" &&
                project.messages.at(-1)?.text === pendingMessage) && (
                <WorkspaceAgentMessage
                  item={{
                    id: "local-user",
                    role: "user",
                    text: pendingMessage,
                    at: "",
                  }}
                  openFile={openFile}
                />
              )}
            {transient && (
              <WorkspaceAgentMessage
                item={transient}
                live={streaming}
                openFile={openFile}
              />
            )}
            {streaming && (reconnecting || retry) && (
              <div className="agent-working" role="status">
                <LoaderCircle size={13} className="animate-spin" />
                <span>
                  {reconnecting
                    ? "Connection interrupted. Reconnecting to your coding partner…"
                    : `Model connection interrupted. Retry ${retry!.attempt} of ${retry!.maxAttempts} in ${Math.ceil(retry!.delayMs / 1000)}s…`}
                </span>
              </div>
            )}
            {streaming &&
              !transient?.text &&
              !transient?.thinking &&
              !transient?.tools?.length &&
              !retry &&
              !reconnecting && (
                <div className="agent-working">
                  <LoaderCircle size={13} className="animate-spin" /> Reading,
                  thinking, building<span>…</span>
                </div>
              )}
          </>
        )}
        {!project.agent.available && (
          <details className="agent-setup">
            <summary>
              Connect your coding partner <ChevronDown size={12} />
            </summary>
            <p>
              Add <code>OPENROUTER_API_KEY</code> to the server’s{" "}
              <code>.env</code> and restart the runtime. You can edit, preview,
              and apply apps now.
            </p>
          </details>
        )}
        <div ref={bottom} />
      </div>
      <div className="agent-composer-area">
        {selectedFile && (
          <div className="agent-file-context">
            <FileCode2 size={12} />
            <span title={selectedFile}>{fileLabel(selectedFile)}</span>
            <span>in context</span>
          </div>
        )}
        <form
          className="agent-composer"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={input}
            aria-label="Instructions for the coding partner"
            placeholder={
              selectedFile
                ? "What should we change here?"
                : "What should we build?"
            }
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
            disabled={streaming || clearing}
            rows={2}
          />
          <div className="agent-composer-toolbar">
            <label className="agent-model-select">
              <Sparkles size={11} />
              <select
                aria-label="Agent model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={streaming}
              >
                {project.agent.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={10} />
            </label>
            {streaming ? (
              <button
                type="button"
                className="agent-send stop"
                onClick={onStop}
                aria-label="Stop agent"
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                className="agent-send"
                disabled={
                  !draft.trim() || !project.agent.available || project.busy || clearing
                }
                aria-label="Send instructions"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </form>
      </div>
    </aside>
  );
}
