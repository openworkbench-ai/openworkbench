import { useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code2,
  FileCode2,
  FileJson2,
  Layers3,
  Plus,
  Search,
} from "lucide-react";
import type { SourceFiles } from "@/lib/workspace-api";
import { fileLabel } from "@/lib/workspace-model";

export function FileIcon({ path, size = 14 }: { path: string; size?: number }) {
  const Icon = path.endsWith(".md")
    ? BookOpen
    : path.endsWith(".py")
      ? Code2
      : path.endsWith(".tsx") || path.endsWith(".ts")
        ? FileCode2
        : FileJson2;
  return (
    <Icon
      size={size}
      className={`file-icon file-icon-${path.endsWith(".md") ? "md" : path.endsWith(".py") ? "py" : path.endsWith(".tsx") ? "tsx" : "json"}`}
    />
  );
}

export function FileExplorer({
  files,
  baseFiles,
  selected,
  onSelect,
  onAdd,
  disabled,
  filter,
  setFilter,
}: {
  files: SourceFiles;
  baseFiles: SourceFiles;
  selected?: string;
  onSelect: (path: string) => void;
  onAdd: (kind?: string) => void;
  disabled?: boolean;
  filter: string;
  setFilter: (value: string) => void;
}) {
  const [closed, setClosed] = useState<string[]>([]);
  const groups = [
    {
      name: "skills",
      label: "Skills",
      icon: BookOpen,
      prefix: "skills/",
      hint: "Agent instructions · Markdown",
      kind: "skill",
    },
    {
      name: "components",
      label: "Components",
      icon: Layers3,
      prefix: "ui/components/",
      hint: "Tool interfaces · React",
      kind: "component",
    },
    {
      name: "functions",
      label: "Functions",
      icon: Code2,
      prefix: "functions/",
      hint: "Custom logic · Python",
      kind: "function",
    },
    {
      name: "data",
      label: "Seed data",
      icon: FileJson2,
      prefix: "data/",
      hint: "Initial records · JSON",
      kind: "data",
    },
  ];
  const paths = Object.keys(files).sort();
  const matches = (path: string) =>
    !filter || path.toLowerCase().includes(filter.toLowerCase());
  const row = (path: string) => (
    <button
      key={path}
      className={`explorer-file ${selected === path ? "selected" : ""}`}
      onClick={() => onSelect(path)}
      title={path}
    >
      <FileIcon path={path} />
      <span>
        {path.endsWith("SKILL.md")
          ? `${fileLabel(path)}/SKILL.md`
          : fileLabel(path)}
      </span>
      {files[path] !== baseFiles[path] && (
        <span
          className={`file-change-marker ${path in baseFiles ? "modified" : "added"}`}
        >
          {path in baseFiles ? "M" : "U"}
        </span>
      )}
    </button>
  );
  return (
    <aside className="file-explorer" aria-label="App source explorer">
      <div className="explorer-title">
        <span>EXPLORER</span>
        <button
          className="icon-button"
          disabled={disabled}
          onClick={() => onAdd()}
          aria-label="Add app file"
          title="Add app file"
        >
          <Plus size={15} />
        </button>
      </div>
      <label className="explorer-search">
        <Search size={12} />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Find a file…"
          aria-label="Find a source file"
        />
        {filter && (
          <button onClick={() => setFilter("")} aria-label="Clear file search">
            ×
          </button>
        )}
      </label>
      <div className="explorer-root">
        <span className="root-dot" /> APP SOURCE <span>{paths.length}</span>
      </div>
      <div className="explorer-files">
        {matches("manifest.json") && row("manifest.json")}
        {groups.map((group) => {
          const groupFiles = paths.filter(
            (path) => path.startsWith(group.prefix) && matches(path),
          );
          const isClosed = closed.includes(group.name) && !filter;
          if (filter && !groupFiles.length) return null;
          return (
            <div className="explorer-group" key={group.name}>
              <div className="explorer-group-heading">
                <button
                  onClick={() =>
                    setClosed((prev) =>
                      isClosed
                        ? prev.filter((name) => name !== group.name)
                        : [...prev, group.name],
                    )
                  }
                  title={group.hint}
                  aria-expanded={!isClosed}
                >
                  {isClosed ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                  <group.icon size={13} />
                  <span>{group.label}</span>
                  <span className="explorer-group-count">
                    {groupFiles.length}
                  </span>
                </button>
                <button
                  className="explorer-group-add"
                  disabled={disabled}
                  onClick={() => onAdd(group.kind)}
                  aria-label={`Add ${group.label.toLowerCase()}`}
                >
                  <Plus size={12} />
                </button>
              </div>
              {!isClosed && (
                <div className="explorer-group-files">
                  {groupFiles.length ? (
                    groupFiles.map(row)
                  ) : (
                    <button
                      disabled={disabled}
                      className="explorer-empty"
                      onClick={() => onAdd(group.kind)}
                    >
                      + Add{" "}
                      {group.kind === "data" ? "seed data" : `a ${group.kind}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {filter && !paths.some(matches) && (
          <p className="explorer-no-results">No matching files.</p>
        )}
      </div>
    </aside>
  );
}
