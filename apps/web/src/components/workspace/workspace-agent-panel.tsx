import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Code2,
  FileCode2,
  LoaderCircle,
  MessageSquare,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import type { WorkspaceMessage, WorkspaceProject } from "@/lib/workspace-api";
import { fileLabel } from "@/lib/workspace-model";

export function WorkspaceAgentPanel({
  project,
  selectedFile,
  streaming,
  transient,
  onSend,
  onStop,
  onClose,
  openFile,
  initialPrompt,
}: {
  project: WorkspaceProject;
  selectedFile?: string;
  streaming: boolean;
  transient?: WorkspaceMessage;
  onSend: (message: string, modelId: string) => void;
  onStop: () => void;
  onClose: () => void;
  openFile: (path: string) => void;
  initialPrompt?: { text: string; key: number };
}) {
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(project.agent.model);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [localUser, setLocalUser] = useState("");
  useEffect(() => {
    if (initialPrompt) {
      setDraft(initialPrompt.text);
      input.current?.focus();
    }
  }, [initialPrompt]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [project.messages, transient?.text, transient?.tools?.length, streaming]);
  useEffect(() => {
    if (!streaming) setLocalUser("");
  }, [streaming]);
  const submit = () => {
    if (!draft.trim() || streaming || !project.agent.available) return;
    setLocalUser(draft.trim());
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
  function message(item: WorkspaceMessage) {
    return (
      <div key={item.id} className={`workspace-message message-${item.role}`}>
        <div className="message-byline">
          {item.role === "assistant" ? (
            <>
              <span className="agent-mini-mark">✻</span> WORKBENCH
            </>
          ) : (
            "YOU"
          )}
        </div>
        {item.text && (
          <div className="workspace-message-body">
            <Markdown content={item.text} />
          </div>
        )}
        {item.tools && item.tools.length > 0 && (
          <div className="agent-tool-activity">
            {item.tools.map((tool, i) => (
              <button
                key={i}
                disabled={!tool.path}
                onClick={() => tool.path && openFile(tool.path)}
                className={tool.error ? "tool-error" : ""}
              >
                {tool.error ? <X size={12} /> : <Check size={12} />}
                <span>{tool.name.replaceAll("_", " ")}</span>
                {tool.path && (
                  <code title={tool.path}>{fileLabel(tool.path)}</code>
                )}
              </button>
            ))}
          </div>
        )}
        {item.error && <div className="agent-error">{item.error}</div>}
      </div>
    );
  }
  return (
    <aside className="workspace-agent-panel" aria-label="App coding partner">
      <div className="agent-panel-header">
        <span>
          <Sparkles size={15} /> Coding partner
        </span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close agent panel"
        >
          <X size={14} />
        </button>
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
            <h2>
              An extra pair
              <br />
              of hands.
            </h2>
            <p>
              You bring the idea. Explore the code, make a change, or build it
              together.
            </p>
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
              <span className="small-spark">✧</span>
              <p>
                Changes go into your draft.
                <br />
                <strong>You decide what goes live.</strong>
              </p>
            </div>
          </div>
        ) : (
          <>
            {project.messages.map(message)}
            {streaming &&
              localUser &&
              message({
                id: "local-user",
                role: "user",
                text: localUser,
                at: "",
              })}
            {transient && message(transient)}
            {streaming && !transient?.text && (
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
            disabled={streaming}
            rows={3}
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
                  !draft.trim() || !project.agent.available || project.busy
                }
                aria-label="Send instructions"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </form>
        <p className="composer-footnote">
          Your files. Your decisions. Your app.
        </p>
      </div>
    </aside>
  );
}
