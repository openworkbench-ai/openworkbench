import {
  createWorkspaceChatState,
  reduceWorkspaceChat,
  type WorkspaceChatState,
} from "../../../../packages/workspace-chat";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronRight,
  CircleCheck,
  Code2,
  Eye,
  FileJson2,
  GitBranch,
  GitCompareArrows,
  History,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  PanelLeft,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Database,
  TriangleAlert,
} from "lucide-react";
import { AppOverview } from "@/components/workspace/app-overview";
import { FileExplorer, FileIcon } from "@/components/workspace/file-explorer";
import { WorkspaceAgentPanel } from "@/components/workspace/workspace-agent-panel";
import { ComponentPreview } from "@/components/workspace/component-preview";
import { Markdown } from "@/components/ui/markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useWorkspace } from "@/hooks/use-workspace";
import { activateApp, deactivateApp, fetchApps } from "@/lib/api";
import {
  applyWorkspace,
  clearWorkspaceChat,
  restoreWorkspace,
  streamWorkspaceChat,
  validateWorkspace,
  type WorkspaceProject,
  type WorkspaceRevision,
  type WorkspaceValidation,
} from "@/lib/workspace-api";
import {
  fileLabel,
  parseAppManifest,
  relativeDate,
  sourceLanguage,
} from "@/lib/workspace-model";
import { DataTab } from "@/pages/app-detail-page";
import "@/styles/workspace.css";

const SourceEditor = lazy(() =>
  import("@/components/workspace/source-editor").then((m) => ({
    default: m.SourceEditor,
  })),
);
const SourceDiff = lazy(() =>
  import("@/components/workspace/source-editor").then((m) => ({
    default: m.SourceDiff,
  })),
);
type WorkspaceView =
  "overview" | "code" | "preview" | "data" | "history" | "changes";
const views = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "code", label: "Code", icon: Code2 },
  { id: "preview", label: "Preview", icon: Eye },
  { id: "data", label: "Data", icon: Database },
  { id: "history", label: "History", icon: History },
] as const;

function newFile(kind: string, name: string, project: WorkspaceProject) {
  if (kind === "skill") {
    if (!/^[a-z][a-z0-9_-]*$/.test(name))
      throw new Error(
        "Use a lowercase skill name with letters, numbers, hyphens, or underscores.",
      );
    return {
      path: `skills/${name}/SKILL.md`,
      content: `---\nname: ${name}\ndescription: Describe when the agent should use this skill.\n---\n\n# ${name.replaceAll("-", " ").replaceAll("_", " ")}\n\nWrite the instructions your agent should follow here.\n\n## How to work\n\n- Understand the user's goal.\n- Use this app's tools to help.\n- Keep the user in control.\n`,
    };
  }
  if (kind === "component") {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name))
      throw new Error("Use a PascalCase component name, like ProgressCard.");
    return {
      path: `ui/components/${name}.tsx`,
      content: `import { Card, CardHeader, CardTitle, CardContent, Muted } from "@openworkbench/app-ui-kit"\n\nexport default function ${name}(props: { title?: string }) {\n  return (\n    <Card>\n      <CardHeader><CardTitle>{props.title ?? "Something useful"}</CardTitle></CardHeader>\n      <CardContent><Muted>Make this view your own.</Muted></CardContent>\n    </Card>\n  )\n}\n`,
    };
  }
  if (kind === "function") {
    if (!/^[a-z][a-z0-9_]*$/.test(name))
      throw new Error(
        "Use a lowercase function name with letters, numbers, and underscores.",
      );
    return {
      path: `functions/${name}.py`,
      content: `def main():\n    """Your app's custom logic. Returns JSON-compatible data."""\n    return {"message": "Ready to build something useful."}\n`,
    };
  }
  const manifest = parseAppManifest(project.files["manifest.json"]);
  if (
    !/^[a-z][a-z0-9_]*$/.test(name) ||
    !manifest?.entities.some((e) => e.name === name)
  )
    throw new Error(
      "Use an entity name from your manifest for the seed data file.",
    );
  return { path: `data/${name}.json`, content: "[]\n" };
}

function Workspace({ id }: { id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const startupPrompt = useRef(
    typeof location.state?.initialPrompt === "string"
      ? location.state.initialPrompt.trim()
      : "",
  );
  const {
    project,
    files,
    loadingError,
    saveError,
    saving,
    unsaved,
    edit,
    flush,
    accept,
    reload,
  } = useWorkspace(id);
  const [view, setView] = useState<WorkspaceView>("overview");
  const [scope, setScope] = useState<"draft" | "live">("draft");
  const [activeFile, setActiveFile] = useState("manifest.json");
  const [openFiles, setOpenFiles] = useState<string[]>(["manifest.json"]);
  const [fileSearch, setFileSearch] = useState("");
  const [agentOpen, setAgentOpen] = useState(() => window.innerWidth >= 1180);
  const [explorerOpen, setExplorerOpen] = useState(
    () => window.innerWidth >= 900,
  );
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [validation, setValidation] = useState<WorkspaceValidation | null>(
    null,
  );
  const [operation, setOperation] = useState("");
  const [operationError, setOperationError] = useState("");
  const [review, setReview] = useState(false);
  const [releaseMessage, setReleaseMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [fileKind, setFileKind] = useState("skill");
  const [newName, setNewName] = useState("");
  const [fileError, setFileError] = useState("");
  const [deletePath, setDeletePath] = useState<string | null>(null);
  const [restore, setRestore] = useState<WorkspaceRevision | "discard" | null>(
    null,
  );
  const [streaming, setStreaming] = useState(false);
  const [pendingMessage, setPendingMessage] = useState("");
  const [chat, setChat] = useState<WorkspaceChatState>();
  const transient = chat?.message;
  const abort = useRef<AbortController | null>(null);
  const chatRunning = useRef(false);
  const resumedRun = useRef<string | undefined>(undefined);
  const [initialPrompt, setInitialPrompt] = useState<{
    text: string;
    key: number;
  }>();
  const [selectedChange, setSelectedChange] = useState("");
  const [appEnabled, setAppEnabled] = useState(true);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const manifest = useMemo(
    () => parseAppManifest(files["manifest.json"] ?? ""),
    [files],
  );
  const liveManifest = useMemo(
    () => parseAppManifest(project?.baseFiles["manifest.json"] ?? ""),
    [project?.baseFiles],
  );
  const changes = useMemo(
    () =>
      !project
        ? []
        : [
            ...new Set([
              ...Object.keys(files),
              ...Object.keys(project.baseFiles),
            ]),
          ]
            .sort()
            .filter((path) => files[path] !== project.baseFiles[path])
            .map((path) => ({
              path,
              kind: !(path in project.baseFiles)
                ? "added"
                : !(path in files)
                  ? "deleted"
                  : "modified",
              author: project.authors[path] ?? "you",
            })),
    [files, project],
  );
  const locked = streaming || !!operation || !!project?.busy;
  const checksCurrent =
    !!validation && validation.version === project?.version && !unsaved;
  const revision = project?.revisions.at(-1)?.number ?? 0;

  useEffect(() => () => abort.current?.abort("disconnect"), []);
  useEffect(() => {
    const runId = project?.activeRunId;
    if (
      !runId ||
      chatRunning.current ||
      resumedRun.current === runId ||
      unsaved ||
      operation
    )
      return;
    resumedRun.current = runId;
    void send("", project.agent.model, runId);
  }, [project?.activeRunId, project?.agent.model, unsaved, operation]);
  useEffect(() => {
    if (!project || !startupPrompt.current || unsaved || operation) return;
    const text = startupPrompt.current;
    startupPrompt.current = "";
    // Consume the handoff before starting so reloads and back navigation cannot
    // submit the same creation prompt again. Active runs reconnect above.
    navigate(location.pathname, { replace: true, state: null });
    setAgentOpen(true);
    if (project.messages.length || project.busy) return;
    const restorePrompt = () => setInitialPrompt({ text, key: Date.now() });
    if (!project.agent.available) {
      restorePrompt();
      return;
    }
    void send(text, project.agent.model).then((sent) => {
      if (!sent) restorePrompt();
    });
  }, [project, unsaved, operation, navigate, location.pathname]);
  useEffect(() => {
    const partnerBreakpoint = window.matchMedia("(min-width: 1101px)");
    const explorerBreakpoint = window.matchMedia("(min-width: 901px)");
    const partnerChanged = () => {
      if (!partnerBreakpoint.matches) setAgentOpen(false);
    };
    const explorerChanged = () => {
      if (!explorerBreakpoint.matches) setExplorerOpen(false);
    };
    partnerBreakpoint.addEventListener("change", partnerChanged);
    explorerBreakpoint.addEventListener("change", explorerChanged);
    return () => {
      partnerBreakpoint.removeEventListener("change", partnerChanged);
      explorerBreakpoint.removeEventListener("change", explorerChanged);
    };
  }, []);
  useEffect(() => {
    if (!project?.busy || streaming || operation || unsaved) return;
    const timer = window.setInterval(() => {
      void reload().catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [project?.busy, streaming, operation, unsaved, reload]);
  useEffect(() => {
    if (project?.installed)
      void fetchApps()
        .then(({ apps }) => {
          setAppEnabled(
            apps.find((app) => app.id === id)?.status !== "inactive",
          );
        })
        .catch(() => {});
  }, [id, project?.installed]);
  useEffect(() => {
    if (
      !files[activeFile] &&
      Object.keys(files).length &&
      !(activeFile in files)
    )
      setActiveFile("manifest.json");
  }, [files, activeFile]);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void flush().catch(() => {});
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "e"
      ) {
        event.preventDefault();
        setExplorerOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, [flush]);

  function openFile(path: string) {
    if (!(path in files)) {
      toast("That file is not in this draft. Add it from the explorer.");
      return;
    }
    setOpenFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveFile(path);
    setView("code");
    setMarkdownPreview(false);
    if (window.innerWidth < 900) setExplorerOpen(false);
  }
  function addFile(kind = "skill") {
    setFileKind(kind === "manifest" ? "skill" : kind);
    setNewName("");
    setFileError("");
    setAddOpen(true);
  }
  const fail = (error: unknown) =>
    setOperationError(error instanceof Error ? error.message : String(error));
  async function runChecks(forReview = false) {
    setOperation(forReview ? "review" : "validate");
    setOperationError("");
    if (forReview) {
      setReview(true);
      setConfirmed(false);
    }
    try {
      const current = await flush();
      const result = await validateWorkspace(id, current.version);
      setValidation(result);
      if (!forReview)
        toast(
          result.valid
            ? "All checks passed. Your draft is ready."
            : `${result.problems.length} validation problem${result.problems.length === 1 ? "" : "s"}.`,
        );
    } catch (error) {
      fail(error);
    } finally {
      setOperation("");
    }
  }
  async function apply() {
    setOperation("apply");
    setOperationError("");
    try {
      const current = await flush();
      const next = await applyWorkspace(
        id,
        current.version,
        releaseMessage || (current.installed ? "Updated app" : "First release"),
        confirmed,
      );
      accept(next);
      setValidation(null);
      setReview(false);
      setReleaseMessage("");
      toast(current.installed ? "Changes applied." : "App launched.");
      window.dispatchEvent(new Event("owb:apps-changed"));
    } catch (error) {
      fail(error);
    } finally {
      setOperation("");
    }
  }
  async function restoreSource() {
    if (!restore) return;
    setOperation("restore");
    setOperationError("");
    try {
      const current = await flush();
      const next = await restoreWorkspace(
        id,
        current.version,
        restore === "discard" ? undefined : restore.id,
      );
      accept(next);
      setValidation(null);
      setRestore(null);
      toast("Source restored to your draft. Review and apply when ready.");
    } catch (error) {
      fail(error);
    } finally {
      setOperation("");
    }
  }
  async function createFile() {
    if (!project) return;
    try {
      const source = newFile(fileKind, newName.trim(), { ...project, files });
      if (source.path in files)
        throw new Error("A file with that name already exists.");
      let updatedManifest: string | undefined;
      if (fileKind === "function") {
        const raw = JSON.parse(files["manifest.json"]);
        if (
          (raw.functions && !Array.isArray(raw.functions)) ||
          (raw.tools && !Array.isArray(raw.tools))
        )
          throw new Error(
            "Fix the manifest's functions and tools arrays before adding a function.",
          );
        if (
          raw.functions?.some(
            (fn: { id?: string }) => fn.id === `fn_${newName.trim()}`,
          ) ||
          raw.tools?.some(
            (tool: { id?: string }) => tool.id === `tool_${newName.trim()}`,
          )
        )
          throw new Error(
            "A function or tool with that name already exists in the manifest.",
          );
        raw.functions = [
          ...(raw.functions ?? []),
          {
            id: `fn_${newName.trim()}`,
            name: newName.trim(),
            runtime: "python",
            entry: source.path,
            handler: "main",
            capabilities: {},
          },
        ];
        raw.tools = [
          ...(raw.tools ?? []),
          {
            id: `tool_${newName.trim()}`,
            name: newName.trim(),
            description: `Run ${newName.trim().replaceAll("_", " ")}`,
            function: `fn_${newName.trim()}`,
            params: [],
          },
        ];
        updatedManifest = JSON.stringify(raw, null, 2) + "\n";
      }
      edit(source.path, source.content);
      if (updatedManifest) edit("manifest.json", updatedManifest);
      setOpenFiles((prev) => [...prev, source.path]);
      setActiveFile(source.path);
      setView("code");
      setMarkdownPreview(false);
      setAddOpen(false);
      setValidation(null);
      if (window.innerWidth < 900) setExplorerOpen(false);
    } catch (error) {
      setFileError((error as Error).message);
    }
  }
  async function send(message: string, modelId: string, resumeRunId?: string) {
    if (chatRunning.current || operation) return;
    chatRunning.current = true;
    setPendingMessage(resumeRunId ? "" : message);
    setOperationError("");
    setStreaming(true);
    setValidation(null);
    const controller = new AbortController();
    abort.current = controller;
    setChat(createWorkspaceChatState("streaming"));
    let refreshes = Promise.resolve();
    try {
      const current = await flush();
      await streamWorkspaceChat(
        id,
        {
          version: current.version,
          message,
          modelId,
          selectedFile: view === "code" ? activeFile : undefined,
        },
        (event) => {
          setChat(
            (previous) => previous && reduceWorkspaceChat(previous, event),
          );
          if (event.type === "tool_end") {
            if (
              ["write_file", "edit_file", "delete_file"].includes(
                event.toolName,
              )
            )
              refreshes = refreshes
                .then(() => reload())
                .then(() => {})
                .catch(() => {});
          }
        },
        controller.signal,
        resumeRunId,
      );
      return true;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        fail(error);
        toast((error as Error).message);
      }
      return false;
    } finally {
      await refreshes;
      await reload().catch(fail);
      setStreaming(false);
      setPendingMessage("");
      setChat(undefined);
      chatRunning.current = false;
    }
  }
  async function clearChat() {
    if (locked || chatRunning.current) return;
    setOperation("clear-chat");
    setOperationError("");
    try {
      const current = await flush();
      accept(await clearWorkspaceChat(id, current.version));
      setChat(undefined);
    } catch (error) {
      fail(error);
      toast((error as Error).message);
    } finally {
      setOperation("");
    }
  }
  function askAboutFile() {
    setAgentOpen(true);
    setInitialPrompt({
      text: `Explain ${activeFile} and how I could improve it. Don't make changes yet.`,
      key: Date.now(),
    });
  }

  if (loadingError)
    return (
      <div className="workspace-opening">
        <TriangleAlert size={27} />
        <h1>We couldn’t open this workspace.</h1>
        <p>{loadingError}</p>
        <Button asChild variant="outline">
          <Link to="/apps">
            <ArrowLeft /> Back to apps
          </Link>
        </Button>
      </div>
    );
  if (!project)
    return (
      <div className="workspace-opening">
        <span className="opening-mark">✻</span>
        <h1>Loading workspace…</h1>
        <LoaderCircle size={20} className="animate-spin" />
      </div>
    );
  const effectiveManifest = scope === "live" ? liveManifest : manifest;
  const displayedChange =
    changes.find((change) => change.path === selectedChange) ?? changes[0];
  const currentProblems = checksCurrent ? (validation?.problems ?? []) : [];

  return (
    <div
      className={`app-workspace ${agentOpen ? "has-agent" : ""}`}
      ref={workspaceRef}
    >
      <header className="workspace-header">
        <div className="workspace-breadcrumb">
          <button
            onClick={() => {
              void flush()
                .then(() => navigate("/apps"))
                .catch(fail);
            }}
            aria-label="Back to apps"
          >
            <ArrowLeft size={15} />
          </button>
          <Link
            to="/apps"
            onClick={(event) => {
              event.preventDefault();
              void flush()
                .then(() => navigate("/apps"))
                .catch(fail);
            }}
          >
            Your apps
          </Link>
          <ChevronRight size={12} />
          <span
            className="workspace-app-icon"
            style={{ backgroundColor: `${manifest?.app.color ?? "#61754e"}18` }}
          >
            {manifest?.app.emoji ?? "✻"}
          </span>
          <strong>{manifest?.app.name ?? "Untitled app"}</strong>
          <span
            className={`workspace-state ${project.installed && appEnabled ? "is-live" : ""}`}
          >
            <span />
            {project.installed ? (appEnabled ? "Live" : "Disabled") : "Draft"}
          </span>
        </div>
        <div className="workspace-header-actions">
          <span className={`save-state ${saveError ? "is-error" : ""}`}>
            {saving ? (
              <LoaderCircle size={12} className="animate-spin" />
            ) : saveError ? (
              <TriangleAlert size={12} />
            ) : (
              <CheckCheck size={13} />
            )}
            {saving
              ? "Saving…"
              : saveError
                ? "Save failed"
                : unsaved
                  ? "Unsaved edits"
                  : "Draft saved"}
          </span>
          <button
            className={`agent-toggle ${agentOpen ? "selected" : ""}`}
            onClick={() => setAgentOpen((prev) => !prev)}
            aria-label="Toggle coding partner"
          >
            <Sparkles size={14} />
            <span>Partner</span>
          </button>
          <Button
            size="sm"
            className="review-button"
            disabled={locked || (!changes.length && project.installed)}
            onClick={() => void runChecks(true)}
          >
            {operation === "review" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <GitBranch />
            )}
            {project.installed ? "Review & apply" : "Review & launch"}
            {changes.length > 0 && <span>{changes.length}</span>}
          </Button>
        </div>
      </header>
      {(saveError || (operationError && !review)) && (
        <div className="workspace-global-error" role="alert">
          <TriangleAlert size={14} />
          <span>{saveError || operationError}</span>
          {saveError ? (
            <>
              <button onClick={() => void flush().catch(fail)}>
                Retry save
              </button>
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      "Reload the server draft? Copy any unsaved edits first.",
                    )
                  )
                    void reload().catch(fail);
                }}
              >
                Reload
              </button>
            </>
          ) : (
            <button
              onClick={() => setOperationError("")}
              aria-label="Dismiss error"
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}
      <div className="workspace-body">
        {view === "code" && explorerOpen && (
          <>
            <div
              className="explorer-mobile-backdrop"
              onClick={() => setExplorerOpen(false)}
            />
            <FileExplorer
              files={files}
              baseFiles={project.baseFiles}
              selected={activeFile}
              onSelect={openFile}
              onAdd={addFile}
              disabled={locked}
              filter={fileSearch}
              setFilter={setFileSearch}
            />
          </>
        )}
        <div className="workspace-center">
          <nav className="workspace-tabs" aria-label="App workspace views">
            {view === "code" && (
              <button
                className="explorer-toggle"
                onClick={() => setExplorerOpen((value) => !value)}
                aria-label="Toggle source explorer"
                aria-expanded={explorerOpen}
              >
                <PanelLeft size={15} />
              </button>
            )}
            {views.map((item) => (
              <button
                key={item.id}
                aria-current={view === item.id ? "page" : undefined}
                className={view === item.id ? "active" : ""}
                onClick={() => setView(item.id)}
              >
                <item.icon size={14} />
                <span>{item.label}</span>
              </button>
            ))}
            <button
              className={`changes-tab ${view === "changes" ? "active" : ""}`}
              onClick={() => setView("changes")}
            >
              <GitCompareArrows size={14} />
              <span>Changes</span>
              {changes.length > 0 && <i>{changes.length}</i>}
            </button>
          </nav>
          <div className={`workspace-content content-${view}`}>
            {view === "overview" &&
              (effectiveManifest ? (
                <AppOverview
                  manifest={effectiveManifest}
                  files={scope === "live" ? project.baseFiles : files}
                  installed={project.installed}
                  revision={revision}
                  scope={scope}
                  openFile={openFile}
                  addFile={addFile}
                  onScope={setScope}
                />
              ) : (
                <div className="workspace-empty-state">
                  <FileJson2 size={32} />
                  <h2>Invalid manifest JSON</h2>
                  <p>
                    Your draft is saved. Fix its JSON to bring the overview
                    back.
                  </p>
                  <Button onClick={() => openFile("manifest.json")}>
                    Open manifest
                  </Button>
                </div>
              ))}
            {view === "code" && (
              <div className="code-workspace">
                <div className="editor-file-tabs">
                  {openFiles
                    .filter((path) => path in files)
                    .map((path) => (
                      <div
                        key={path}
                        className={`editor-file-tab ${activeFile === path ? "active" : ""}`}
                      >
                        <button
                          onClick={() => {
                            setActiveFile(path);
                            setMarkdownPreview(false);
                          }}
                        >
                          <FileIcon path={path} size={13} />
                          <span>
                            {path.endsWith("SKILL.md")
                              ? `${fileLabel(path)}/SKILL.md`
                              : fileLabel(path)}
                          </span>
                          {files[path] !== project.baseFiles[path] && <i />}
                        </button>
                        <button
                          className="close-file-tab"
                          aria-label={`Close ${fileLabel(path)}`}
                          onClick={() => {
                            const next = openFiles.filter((p) => p !== path);
                            setOpenFiles(
                              next.length ? next : ["manifest.json"],
                            );
                            if (activeFile === path)
                              setActiveFile(next.at(-1) ?? "manifest.json");
                          }}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                </div>
                <div className="editor-toolbar">
                  <span className="editor-path">
                    {activeFile.split("/").map((part, i) => (
                      <span key={i}>
                        {i > 0 && <ChevronRight size={10} />}
                        {part}
                      </span>
                    ))}
                  </span>
                  <div>
                    {activeFile.endsWith(".md") && (
                      <button
                        className={`subtle-button ${markdownPreview ? "selected" : ""}`}
                        onClick={() => setMarkdownPreview((value) => !value)}
                      >
                        {markdownPreview ? (
                          <Code2 size={12} />
                        ) : (
                          <Eye size={12} />
                        )}
                        {markdownPreview ? "Source" : "Read"}
                      </button>
                    )}
                    <button
                      className="icon-button"
                      onClick={askAboutFile}
                      aria-label="Ask agent about this file"
                      title="Ask about this file"
                    >
                      <Sparkles size={13} />
                    </button>
                    {activeFile !== "manifest.json" && (
                      <button
                        className="icon-button"
                        disabled={locked}
                        onClick={() => setDeletePath(activeFile)}
                        aria-label="Delete current file"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="editor-surface">
                  {markdownPreview ? (
                    <div className="markdown-file-preview">
                      <Markdown
                        content={(files[activeFile] ?? "").replace(
                          /^---\r?\n[\s\S]*?\r?\n---\r?\n/,
                          "",
                        )}
                      />
                    </div>
                  ) : (
                    <Suspense
                      fallback={
                        <div className="editor-loading">
                          <LoaderCircle size={18} className="animate-spin" />{" "}
                          Setting up your editor…
                        </div>
                      }
                    >
                      <SourceEditor
                        appId={id}
                        path={activeFile}
                        value={files[activeFile] ?? ""}
                        onChange={(value) => edit(activeFile, value)}
                        onSave={() => void flush().catch(fail)}
                        readOnly={locked}
                        onPosition={(line, column) =>
                          setPosition({ line, column })
                        }
                      />
                    </Suspense>
                  )}
                </div>
                {currentProblems.length > 0 && (
                  <div className="editor-problems">
                    <strong>
                      <TriangleAlert size={13} /> {currentProblems.length}{" "}
                      problem{currentProblems.length === 1 ? "" : "s"}
                    </strong>
                    {currentProblems.map((problem, index) => (
                      <button
                        key={index}
                        onClick={() =>
                          problem.path in files && openFile(problem.path)
                        }
                      >
                        <code>{problem.path}</code>
                        <span>{problem.message}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {view === "preview" &&
              (manifest ? (
                <ComponentPreview
                  project={{ ...project, files }}
                  manifest={manifest}
                  flush={flush}
                  openFile={openFile}
                />
              ) : (
                <div className="workspace-empty-state">
                  <h2>Fix the manifest to preview your app.</h2>
                  <Button onClick={() => openFile("manifest.json")}>
                    Open manifest
                  </Button>
                </div>
              ))}
            {view === "data" && (
              <div className="workspace-data">
                <h1>Data</h1>
                <p className="workspace-section-intro">
                  Explore the records in your running app. Source edits and
                  preview inputs stay separate.
                </p>
                {project.installed ? (
                  <DataTab appId={id} />
                ) : (
                  <div className="workspace-empty-state">
                    <Database size={30} />
                    <h2>No database yet</h2>
                    <p>
                      Launch your app to give it a database. Your draft and any
                      seed data are waiting in the explorer.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => void runChecks(true)}
                    >
                      Review & launch <ArrowRight />
                    </Button>
                  </div>
                )}
                {project.installed && (
                  <div className="app-runtime-setting">
                    <div>
                      <strong>Available to your agent</strong>
                      <p>
                        {appEnabled
                          ? "Your agent can discover and use this app’s tools."
                          : "This app’s tools are disabled. Your source and data are kept."}
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={appEnabled}
                      aria-label="App available to agent"
                      className={`runtime-switch ${appEnabled ? "checked" : ""}`}
                      disabled={locked}
                      onClick={() => {
                        setOperation("toggle");
                        void (appEnabled ? deactivateApp(id) : activateApp(id))
                          .then(() => setAppEnabled((value) => !value))
                          .catch(fail)
                          .finally(() => setOperation(""));
                      }}
                    >
                      <span />
                    </button>
                  </div>
                )}
              </div>
            )}
            {view === "history" && (
              <div className="workspace-history">
                <h1>Revision history</h1>
                <p className="workspace-section-intro">
                  Every release is a checkpoint. Bring an earlier version back
                  into your draft whenever you need it.
                </p>
                {project.revisions.length ? (
                  <div className="revision-timeline">
                    {[...project.revisions].reverse().map((item, index) => (
                      <article key={item.id} className="revision-card">
                        <div className="revision-node">
                          {index === 0 ? (
                            <Check size={14} />
                          ) : (
                            <History size={14} />
                          )}
                        </div>
                        <div className="revision-info">
                          <div>
                            <span className="revision-number">
                              v{item.number}
                            </span>
                            {index === 0 && (
                              <span className="revision-live">
                                RUNNING VERSION
                              </span>
                            )}
                            <time
                              dateTime={item.at}
                              title={new Date(item.at).toLocaleString()}
                            >
                              {relativeDate(item.at)}
                            </time>
                          </div>
                          <h3>{item.message}</h3>
                          <p>
                            {Object.keys(item.files).length} source files ·{" "}
                            {new Date(item.at).toLocaleString(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </p>
                        </div>
                        <button
                          className="subtle-button"
                          disabled={locked}
                          onClick={() => setRestore(item)}
                        >
                          <RotateCcw size={12} /> Restore to draft
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="workspace-empty-state">
                    <History size={30} />
                    <h2>No revisions yet</h2>
                    <p>
                      Launch your first revision to create a source checkpoint.
                    </p>
                  </div>
                )}
                <p className="history-footnote">
                  <ShieldCheck size={13} /> Restoring source changes your draft.
                  Existing app data is kept; schema changes are reviewed when
                  applying.
                </p>
              </div>
            )}
            {view === "changes" && (
              <div className="changes-workspace">
                <div className="changes-heading">
                  <div>
                    <h1>Changes</h1>
                    <p>
                      {changes.length
                        ? `${changes.length} file${changes.length === 1 ? "" : "s"} changed since ${project.installed ? "the running version" : "you started"}.`
                        : "No changes in this draft."}
                    </p>
                  </div>
                  {project.installed && changes.length > 0 && (
                    <button
                      className="subtle-button"
                      disabled={locked}
                      onClick={() => setRestore("discard")}
                    >
                      <RotateCcw size={12} /> Discard all
                    </button>
                  )}
                </div>
                {changes.length > 0 ? (
                  <div className="change-comparison">
                    <div className="changed-file-list">
                      {changes.map((change) => (
                        <div
                          key={change.path}
                          className={
                            displayedChange?.path === change.path
                              ? "selected"
                              : ""
                          }
                        >
                          <button
                            onClick={() => setSelectedChange(change.path)}
                          >
                            <FileIcon path={change.path} size={13} />
                            <span title={change.path}>
                              {fileLabel(change.path)}
                            </span>
                            <i className={`change-letter ${change.kind}`}>
                              {change.kind === "added"
                                ? "A"
                                : change.kind === "deleted"
                                  ? "D"
                                  : "M"}
                            </i>
                          </button>
                          <small>
                            {change.author === "agent"
                              ? "Coding partner"
                              : "You"}
                          </small>
                          <button
                            className="revert-file"
                            title="Revert this file"
                            aria-label={`Revert ${change.path}`}
                            disabled={locked || !project.installed}
                            onClick={() =>
                              edit(
                                change.path,
                                project.baseFiles[change.path] ?? null,
                              )
                            }
                          >
                            <RotateCcw size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="change-diff">
                      <div className="diff-heading">
                        <code>{displayedChange?.path}</code>
                        <span>Running → Draft</span>
                      </div>
                      <Suspense
                        fallback={
                          <div className="editor-loading">
                            Loading comparison…
                          </div>
                        }
                      >
                        <SourceDiff
                          path={displayedChange?.path ?? "manifest.json"}
                          original={
                            project.baseFiles[displayedChange?.path ?? ""] ?? ""
                          }
                          modified={files[displayedChange?.path ?? ""] ?? ""}
                        />
                      </Suspense>
                    </div>
                  </div>
                ) : (
                  <div className="workspace-empty-state">
                    <CircleCheck size={33} />
                    <h2>No changes</h2>
                    <p>
                      Changes you make by hand or with your coding partner will
                      appear here.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => openFile("manifest.json")}
                    >
                      Explore the code <ArrowRight />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
          <footer className="workspace-statusbar">
            <div>
              <span>
                <GitBranch size={11} /> draft
              </span>
              <button
                onClick={() => void runChecks()}
                disabled={locked}
                className={
                  checksCurrent && !validation?.valid ? "status-problems" : ""
                }
              >
                {operation === "validate" ? (
                  <LoaderCircle size={11} className="animate-spin" />
                ) : checksCurrent && validation?.valid ? (
                  <CircleCheck size={11} />
                ) : (
                  <ShieldCheck size={11} />
                )}
                {operation === "validate"
                  ? "Checking…"
                  : checksCurrent
                    ? validation?.valid
                      ? "All checks passed"
                      : `${validation?.problems.length} problems`
                    : "Validate app"}
              </button>
              {changes.length > 0 && (
                <button onClick={() => setView("changes")}>
                  {changes.length} changed
                </button>
              )}
            </div>
            <div>
              {view === "code" && (
                <>
                  <span>
                    Ln {position.line}, Col {position.column}
                  </span>
                  <span>
                    {sourceLanguage(activeFile) === "typescript"
                      ? activeFile.endsWith(".tsx")
                        ? "TypeScript JSX"
                        : "TypeScript"
                      : sourceLanguage(activeFile)}
                  </span>
                </>
              )}
              <span className="statusbar-boundary">
                <ShieldCheck size={10} /> App boundary
              </span>
            </div>
          </footer>
        </div>
        {agentOpen && (
          <>
            <div
              className="agent-mobile-backdrop"
              onClick={() => setAgentOpen(false)}
            />
            <WorkspaceAgentPanel
              project={project}
              selectedFile={view === "code" ? activeFile : undefined}
              streaming={streaming}
              pendingMessage={pendingMessage}
              transient={transient}
              retry={chat?.retry}
              reconnecting={chat?.connection?.status === "reconnecting"}
              clearing={operation === "clear-chat"}
              clearDisabled={locked}
              onClear={() => void clearChat()}
              onSend={(message, model) => void send(message, model)}
              onStop={() => abort.current?.abort()}
              onClose={() => setAgentOpen(false)}
              openFile={openFile}
              initialPrompt={initialPrompt}
            />
          </>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="workspace-dialog">
          <DialogHeader>
            <DialogTitle>Add file</DialogTitle>
            <DialogDescription>
              Choose a file type and name.
            </DialogDescription>
          </DialogHeader>
          <div className="file-kind-options">
            {[
              { kind: "skill", label: "Skill", icon: BookOpen },
              { kind: "component", label: "Component", icon: Layers3 },
              { kind: "function", label: "Function", icon: Code2 },
              { kind: "data", label: "Seed data", icon: Database },
            ].map((item) => (
              <button
                key={item.kind}
                className={fileKind === item.kind ? "selected" : ""}
                onClick={() => {
                  setFileKind(item.kind);
                  setNewName("");
                  setFileError("");
                }}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <label className="workspace-form-label">
            {fileKind === "data" ? "Entity name" : "Name"}
            <Input
              autoFocus
              value={newName}
              placeholder={
                fileKind === "skill"
                  ? "weekly-review"
                  : fileKind === "component"
                    ? "ProgressCard"
                    : fileKind === "function"
                      ? "calculate_progress"
                      : (manifest?.entities[0]?.name ?? "task")
              }
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createFile();
              }}
            />
          </label>
          <div className="new-file-path">
            <FileIcon
              path={
                fileKind === "skill"
                  ? ".md"
                  : fileKind === "component"
                    ? ".tsx"
                    : fileKind === "function"
                      ? ".py"
                      : ".json"
              }
            />
            <code>
              {fileKind === "skill"
                ? `skills/${newName || "your-skill"}/SKILL.md`
                : fileKind === "component"
                  ? `ui/components/${newName || "YourComponent"}.tsx`
                  : fileKind === "function"
                    ? `functions/${newName || "your_function"}.py`
                    : `data/${newName || "entity"}.json`}
            </code>
          </div>
          <p className="dialog-hint">
            {fileKind === "skill"
              ? "Markdown instructions your agent can discover and follow."
              : fileKind === "component"
                ? "A React view for tool results. Reference its name in a tool’s ui.component to connect it."
                : fileKind === "function"
                  ? "Python logic, automatically registered as a function and tool in your manifest. No capabilities are granted by default."
                  : "Starting records, used only when the app’s database is first created."}
          </p>
          {fileError && (
            <p role="alert" className="text-sm text-destructive">
              {fileError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newName.trim() || locked}
              onClick={() => void createFile()}
            >
              <Plus /> Create file
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={review}
        onOpenChange={(value) => {
          if (operation !== "apply") setReview(value);
        }}
      >
        <DialogContent className="workspace-dialog review-dialog">
          <DialogHeader>
            <DialogTitle>
              {project.installed ? "Review changes" : "Review app"}
            </DialogTitle>
            <DialogDescription>
              {project.installed
                ? "Review source and schema changes before applying them."
                : "Launch this revision to make the app and its tools available to your agent."}
            </DialogDescription>
          </DialogHeader>
          {operation === "review" ? (
            <div className="review-checking">
              <LoaderCircle className="animate-spin" size={23} />
              <strong>Running checks…</strong>
              <p>
                Validating the manifest, checking code, and inspecting schema
                changes.
              </p>
            </div>
          ) : (
            <div className="review-scroll">
              {validation && (
                <div
                  className={`validation-banner ${validation.valid ? "passed" : "failed"}`}
                >
                  {validation.valid ? (
                    <CircleCheck size={19} />
                  ) : (
                    <TriangleAlert size={19} />
                  )}
                  <div>
                    <strong>
                      {validation.valid
                        ? "All checks passed"
                        : "Validation failed"}
                    </strong>
                    <p>
                      {validation.valid
                        ? "Manifest validated · Python checked · React type-checked and built"
                        : "Your draft is saved. Fix these problems before applying."}
                    </p>
                  </div>
                </div>
              )}
              {validation?.problems.map((problem, index) => (
                <button
                  className="review-problem"
                  key={index}
                  onClick={() => {
                    setReview(false);
                    openFile(
                      problem.path in files ? problem.path : "manifest.json",
                    );
                  }}
                >
                  <code>{problem.path}</code>
                  <span>{problem.message}</span>
                  <ArrowRight size={13} />
                </button>
              ))}
              <div className="review-file-heading">
                SOURCE CHANGES <span>{changes.length}</span>
              </div>
              <div className="review-files">
                {changes.map((change) => (
                  <button
                    key={change.path}
                    onClick={() => {
                      setSelectedChange(change.path);
                      setView("changes");
                      setReview(false);
                    }}
                  >
                    <FileIcon path={change.path} />
                    <code>{change.path}</code>
                    <span className={change.kind}>{change.kind}</span>
                  </button>
                ))}
              </div>
              {validation?.migration && validation.migration.length > 0 && (
                <div className="review-impact">
                  <h3>What happens to your data</h3>
                  {validation.migration.map((change, index) => (
                    <div
                      key={index}
                      className={change.destructive ? "destructive-impact" : ""}
                    >
                      {change.destructive ? (
                        <TriangleAlert size={13} />
                      ) : (
                        <Check size={13} />
                      )}
                      <span>{change.description}</span>
                    </div>
                  ))}
                </div>
              )}
              {validation?.permissions &&
                ((validation.permissions.network?.length ?? 0) > 0 ||
                  validation.permissions.model ||
                  validation.permissions.data.length > 0) && (
                  <div className="review-impact">
                    <h3>New function capabilities</h3>
                    {validation.permissions.network?.map((host) => (
                      <p key={host}>
                        Network access: <code>{host}</code>
                      </p>
                    ))}
                    {validation.permissions.model && (
                      <p>Access to the model broker</p>
                    )}
                    {validation.permissions.data.map((grant) => (
                      <p key={grant}>
                        Data access: <code>{grant}</code>
                      </p>
                    ))}
                  </div>
                )}
              <label className="workspace-form-label">
                Release note
                <Input
                  placeholder={
                    project.installed
                      ? "What got a little better?"
                      : "First release"
                  }
                  value={releaseMessage}
                  onChange={(event) => setReleaseMessage(event.target.value)}
                  maxLength={300}
                />
              </label>
              {validation?.requiresConfirmation && (
                <label className="review-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>
                    I reviewed the schema changes and new capabilities above,
                    and approve applying them.
                  </span>
                </label>
              )}
            </div>
          )}
          {operationError && (
            <div className="workspace-error" role="alert">
              {operationError}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={operation === "apply"}
              onClick={() => setReview(false)}
            >
              Keep editing
            </Button>
            <Button
              disabled={
                !!operation ||
                !validation?.valid ||
                !checksCurrent ||
                (!!validation?.requiresConfirmation && !confirmed)
              }
              onClick={() => void apply()}
            >
              {operation === "apply" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Check />
              )}
              {operation === "apply"
                ? "Applying…"
                : project.installed
                  ? "Apply changes"
                  : "Launch app"}
            </Button>
          </DialogFooter>
          <p className="review-footer-note">
            <ShieldCheck size={11} /> Source revisions are saved. Existing app
            records are preserved unless a removal above is approved.
          </p>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deletePath}
        onOpenChange={(value) => !value && setDeletePath(null)}
      >
        <DialogContent className="workspace-dialog">
          <DialogHeader>
            <DialogTitle>Remove this file?</DialogTitle>
            <DialogDescription>
              <code>{deletePath}</code> will be removed from the draft. Update
              any manifest references before applying.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeletePath(null)}>
              Keep file
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deletePath) edit(deletePath, null);
                setDeletePath(null);
                setView("changes");
                setValidation(null);
              }}
            >
              <Trash2 /> Remove from draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!restore}
        onOpenChange={(value) => !value && setRestore(null)}
      >
        <DialogContent className="workspace-dialog">
          <DialogHeader>
            <DialogTitle>
              {restore === "discard"
                ? "Back to the running version?"
                : "Bring this version back?"}
            </DialogTitle>
            <DialogDescription>
              {restore === "discard"
                ? "Replace the current draft with the running source. Your existing app data stays as it is."
                : `Restore ${restore ? `v${restore.number}` : "this revision"} into your draft. This replaces current draft edits. Review and apply it separately to change the running app.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRestore(null)}>
              Keep editing
            </Button>
            <Button disabled={locked} onClick={() => void restoreSource()}>
              {operation === "restore" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RotateCcw />
              )}{" "}
              Restore source
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AppWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  return id ? <Workspace key={id} id={id} /> : null;
}
