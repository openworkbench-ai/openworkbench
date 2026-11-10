import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Code2,
  Grid2X2,
  Layers3,
  List,
  LoaderCircle,
  Plus,
  Search,
  Sparkles,
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
  const [template, setTemplate] = useState("blank");
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
  async function create() {
    setCreating(true);
    setCreateError("");
    try {
      const project = await createWorkspace(name, template);
      window.dispatchEvent(new Event("owb:apps-changed"));
      navigate(`/apps/${project.id}`);
    } catch (error) {
      setCreateError((error as Error).message);
    } finally {
      setCreating(false);
    }
  }
  return (
    <div className="apps-library">
      <header className="library-header">
        <span>
          <span className="tiny-star">✻</span> YOUR WORKBENCH
        </span>
        <span className="library-header-note">A home for your ideas.</span>
      </header>
      <div className="library-scroll">
        <div className="library-content">
          <div className="library-intro">
            <div>
              <div className="library-eyebrow">
                <span /> SMALL TOOLS. BIG POSSIBILITIES.
              </div>
              <h1>Made for your world.</h1>
              <p>
                A collection of apps that work the way you do.
                <br />
                Open one up. See how it works. Make it yours.
              </p>
            </div>
            <Button
              className="library-new-button"
              onClick={() => {
                setCreateOpen(true);
                setCreateError("");
              }}
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
              {draftCount} in the making
            </span>
            <span className="library-summary-tail">
              <Code2 size={13} /> Real code. Yours to shape.
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
              <LoaderCircle className="animate-spin" size={20} /> Bringing your
              apps together…
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
                        ? "In the making"
                        : app.status === "inactive"
                          ? "Disabled"
                          : "Running"}
                    </span>
                    <ArrowUpRight size={18} className="app-card-arrow" />
                  </div>
                  <div className="app-card-copy">
                    <h2>{app.name}</h2>
                    <p>
                      {app.description ||
                        "A little space for your next big idea."}
                    </p>
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
                        Open & explore <ArrowRight size={12} />
                      </span>
                    )}
                  </div>
                </Link>
              ))}
              {!query && filter === "all" && (
                <button
                  className="create-project-card"
                  onClick={() => setCreateOpen(true)}
                >
                  <span className="create-card-icon">
                    <Plus size={24} />
                  </span>
                  <strong>Room for one more.</strong>
                  <p>
                    That idea you keep coming back to?
                    <br />
                    Start here.
                  </p>
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
                  ? "Nothing by that name. Yet."
                  : "A little room to grow."}
              </h2>
              <p>
                {query
                  ? "Try a different search, or turn that idea into a new app."
                  : filter === "draft"
                    ? "Start a new app and shape it at your own pace."
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
          <div className="library-bottom-note">
            <span className="library-note-mark">✧</span>
            <div>
              <strong>You don’t have to build alone.</strong>
              <p>
                Every app has a coding partner. Explore its files, ask a
                question, or make a change together.
              </p>
            </div>
            <span>
              YOU’RE IN CONTROL <Check size={12} />
            </span>
          </div>
        </div>
      </div>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="workspace-dialog create-app-dialog">
          <DialogHeader>
            <span className="dialog-eyebrow">
              FROM A SPARK TO SOMETHING REAL
            </span>
            <DialogTitle>What will you make?</DialogTitle>
            <DialogDescription>
              Start with a little structure, or a clean sheet. You can change
              everything as you go.
            </DialogDescription>
          </DialogHeader>
          <div className="starter-options">
            {[
              {
                id: "blank",
                icon: "✻",
                title: "A fresh canvas",
                description: "A minimal app. A world of possibility.",
              },
              {
                id: "tracker",
                icon: "◈",
                title: "Project tracker",
                description: "Tasks, priorities, and a little momentum.",
              },
              {
                id: "research",
                icon: "⌕",
                title: "Research desk",
                description: "Sources, notes, and the bigger picture.",
              },
            ].map((item) => (
              <button
                key={item.id}
                className={template === item.id ? "selected" : ""}
                onClick={() => setTemplate(item.id)}
              >
                <span className="starter-icon">{item.icon}</span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </div>
                <span className="starter-radio">
                  {template === item.id && <Check size={11} />}
                </span>
              </button>
            ))}
          </div>
          <label className="workspace-form-label">
            Give it a name
            <Input
              autoFocus
              placeholder={
                template === "tracker"
                  ? "Project tracker"
                  : template === "research"
                    ? "Research desk"
                    : "That good idea"
              }
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !creating) void create();
              }}
            />
          </label>
          <p className="dialog-hint">
            <Sparkles size={13} /> Your app opens in its own workspace. Build by
            hand, with your coding partner, or a bit of both.
          </p>
          {createError && (
            <p role="alert" className="text-sm text-destructive">
              {createError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              Not yet
            </Button>
            <Button disabled={creating} onClick={() => void create()}>
              {creating ? <LoaderCircle className="animate-spin" /> : <Plus />}
              {creating ? "Making room…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
