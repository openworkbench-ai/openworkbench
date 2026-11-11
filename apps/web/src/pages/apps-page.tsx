import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Grid2X2,
  Layers3,
  List,
  LoaderCircle,
  Plus,
  Search,
} from "lucide-react";
import { fetchApps, type AppInfo } from "@/lib/api";
import { createWorkspace } from "@/lib/workspace-api";
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
import "@/styles/workspace.css";

export function AppsPage() {
  const navigate = useNavigate();
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [layout, setLayout] = useState("grid");
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [startMode, setStartMode] = useState<"blank" | "prompt">("blank");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState("");
  useEffect(() => {
    fetchApps()
      .then(({ apps }) => setApps(apps))
      .catch((error) => setError(error.message));
  }, []);
  const filtered = useMemo(
    () =>
      apps?.filter(
        (app) =>
          (filter === "all" ||
            (filter === "draft"
              ? app.status === "draft"
              : app.status !== "draft")) &&
          `${app.name} ${app.description}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ) ?? [],
    [apps, query, filter],
  );
  const draftCount = apps?.filter((app) => app.status === "draft").length ?? 0;
  const liveCount = (apps?.length ?? 0) - draftCount;
  function openCreate() {
    setStartMode("blank");
    setPrompt("");
    setName("");
    setCreateError("");
    setCreateOpen(true);
  }
  async function create() {
    if (creating || (startMode === "prompt" && !prompt.trim())) return;
    setCreating(true);
    setCreateError("");
    try {
      const project = await createWorkspace(name);
      window.dispatchEvent(new Event("owb:apps-changed"));
      navigate(`/apps/${project.id}`, {
        state: startMode === "prompt" ? { initialPrompt: prompt.trim() } : null,
      });
    } catch (error) {
      setCreateError((error as Error).message);
    } finally {
      setCreating(false);
    }
  }
  return (
    <div className="apps-library">
      <div className="library-scroll">
        <div className="library-content">
          <div className="library-intro">
            <div>
              <h1>Apps</h1>
            </div>
            <Button
              className="library-new-button"
              onClick={openCreate}
            >
              <Plus size={16} /> New app
            </Button>
          </div>
          <div className="library-summary">
            <span>
              <i className="live-dot" />
              {liveCount} running
            </span>
            <span>
              <i className="draft-dot" />
              {draftCount} drafts
            </span>
          </div>
          <div className="library-toolbar">
            <div className="library-filters">
              {[
                { id: "all", label: "All apps", count: apps?.length ?? 0 },
                { id: "live", label: "Running", count: liveCount },
                { id: "draft", label: "Drafts", count: draftCount },
              ].map((item) => (
                <button
                  key={item.id}
                  className={filter === item.id ? "active" : ""}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                  <span>{item.count}</span>
                </button>
              ))}
            </div>
            <label className="library-search">
              <Search size={14} />
              <input
                placeholder="Find an app…"
                aria-label="Search apps"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="library-layout">
              <button
                aria-label="Grid view"
                className={layout === "grid" ? "selected" : ""}
                onClick={() => setLayout("grid")}
              >
                <Grid2X2 size={15} />
              </button>
              <button
                aria-label="List view"
                className={layout === "list" ? "selected" : ""}
                onClick={() => setLayout("list")}
              >
                <List size={16} />
              </button>
            </div>
          </div>
          {error && (
            <div role="alert" className="workspace-error">
              {error}
            </div>
          )}
          {!apps && !error ? (
            <div className="library-loading">
              <LoaderCircle className="animate-spin" size={20} /> Loading apps…
            </div>
          ) : (
            <div className={`app-collection collection-${layout}`}>
              {filtered.map((app, index) => (
                <Link
                  key={app.id}
                  to={`/apps/${app.id}`}
                  className="app-project-card"
                  style={
                    {
                      "--app-tint": app.color ?? "#61754e",
                      animationDelay: `${index * 40}ms`,
                    } as React.CSSProperties
                  }
                >
                  <div className="app-card-top">
                    <span className="app-project-icon">{app.emoji ?? "✻"}</span>
                    <span
                      className={`app-project-status ${app.status === "draft" ? "draft" : app.status === "inactive" ? "inactive" : "live"}`}
                    >
                      <i />
                      {app.status === "draft"
                        ? "Draft"
                        : app.status === "inactive"
                          ? "Disabled"
                          : "Running"}
                    </span>
                    <ArrowUpRight size={18} className="app-card-arrow" />
                  </div>
                  <div className="app-card-copy">
                    <h2>{app.name}</h2>
                    {app.description && <p>{app.description}</p>}
                  </div>
                  <div className="app-card-footer">
                    <span>
                      <Layers3 size={12} /> App workspace
                    </span>
                    {app.changes ? (
                      <span className="app-card-changes">
                        {app.changes} changed
                      </span>
                    ) : (
                      <span>
                        Open app <ArrowRight size={12} />
                      </span>
                    )}
                  </div>
                </Link>
              ))}
              {!query && filter === "all" && (
                <button
                  className="create-project-card"
                  onClick={openCreate}
                >
                  <span className="create-card-icon">
                    <Plus size={24} />
                  </span>
                  <strong>New app</strong>
                  <span className="create-card-action">
                    Create an app <ArrowRight size={13} />
                  </span>
                </button>
              )}
            </div>
          )}
          {apps && !filtered.length && (query || filter !== "all") && (
            <div className="workspace-empty-state">
              <Search size={27} />
              <h2>
                {query
                  ? "No matching apps"
                  : filter === "draft"
                    ? "No drafts"
                    : "No running apps"}
              </h2>
              <p>
                {query
                  ? "Try a different search."
                  : filter === "draft"
                    ? "Create an app to start a draft."
                    : "Launch a draft to make it available to your agent."}
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Show all apps
              </Button>
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!creating) setCreateOpen(open);
        }}
      >
        <DialogContent className="workspace-dialog create-app-dialog">
          <DialogHeader>
            <DialogTitle>New app</DialogTitle>
            <DialogDescription>
              Start with a blank app or describe what you want to build.
            </DialogDescription>
          </DialogHeader>
          <form
            className="create-app-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="starter-options" role="group" aria-label="How to start">
              {([
                {
                  id: "blank",
                  icon: "✻",
                  title: "Blank app",
                  description: "Start from scratch.",
                },
                {
                  id: "prompt",
                  icon: "✧",
                  title: "Build from a prompt",
                  description: "Describe your idea and let the agent build it.",
                },
              ] as const).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={startMode === item.id}
                  disabled={creating}
                  className={startMode === item.id ? "selected" : ""}
                  onClick={() => setStartMode(item.id)}
                >
                  <span className="starter-icon">{item.icon}</span>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.description}</p>
                  </div>
                  <span className="starter-radio">
                    {startMode === item.id && <Check size={11} />}
                  </span>
                </button>
              ))}
            </div>
            {startMode === "prompt" && (
              <label className="workspace-form-label">
                What would you like to build?
                <textarea
                  autoFocus
                  className="create-app-prompt"
                  placeholder="Describe what your app should do…"
                  rows={4}
                  required
                  maxLength={32000}
                  disabled={creating}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
            )}
            <label className="workspace-form-label">
              App name (optional)
              <Input
                autoFocus={startMode === "blank"}
                placeholder="My app"
                value={name}
                disabled={creating}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {createError && (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="ghost"
                type="button"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={creating || (startMode === "prompt" && !prompt.trim())}
              >
                {creating ? <LoaderCircle className="animate-spin" /> : <Plus />}
                {creating
                  ? "Creating…"
                  : startMode === "prompt"
                    ? "Build app"
                    : "Create app"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
