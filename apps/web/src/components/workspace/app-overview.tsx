import {
  ArrowDown,
  ArrowRight,
  BookOpen,
  Braces,
  Code2,
  Database,
  FileJson2,
  Layers3,
  Link2,
  Network,
  Plus,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import type { AppManifest } from "@/lib/workspace-model";
import { fileLabel } from "@/lib/workspace-model";
import type { SourceFiles } from "@/lib/workspace-api";

const title = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
function skillDescription(content: string) {
  return (
    content.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "") ??
    "Instructions that guide your agent."
  );
}

export function AppOverview({
  manifest,
  files,
  installed,
  revision,
  scope,
  openFile,
  addFile,
  onScope,
}: {
  manifest: AppManifest;
  files: SourceFiles;
  installed: boolean;
  revision: number;
  scope: "draft" | "live";
  openFile: (path: string) => void;
  addFile: (kind?: string) => void;
  onScope: (scope: "draft" | "live") => void;
}) {
  const skills = Object.keys(files).filter((path) => path.endsWith("SKILL.md"));
  const components = Object.keys(files).filter((path) => path.endsWith(".tsx"));
  const functions = Object.keys(files).filter((path) => path.endsWith(".py"));
  const network = [
    ...new Set(
      manifest.functions.flatMap((fn) =>
        Array.isArray(fn.capabilities?.network) ? fn.capabilities.network : [],
      ),
    ),
  ];
  const hasModel = manifest.functions.some((fn) => fn.capabilities?.model);
  const dataGrants = manifest.functions.flatMap((fn) =>
    Array.isArray(fn.capabilities?.data) ? fn.capabilities.data : [],
  );
  const buildingBlocks = [
    {
      name: "Manifest",
      icon: FileJson2,
      detail: `${manifest.entities.length} data model${manifest.entities.length === 1 ? "" : "s"}`,
      count: "01",
      color: "fern",
      path: "manifest.json",
      kind: "manifest",
    },
    {
      name: "Skills",
      icon: BookOpen,
      detail: "Agent instructions",
      count: String(skills.length).padStart(2, "0"),
      color: "clay",
      path: skills[0],
      kind: "skill",
    },
    {
      name: "Components",
      icon: Layers3,
      detail: "React interfaces",
      count: String(components.length).padStart(2, "0"),
      color: "ocean",
      path: components[0],
      kind: "component",
    },
    {
      name: "Functions",
      icon: Code2,
      detail: "Custom logic",
      count: String(functions.length).padStart(2, "0"),
      color: "plum",
      path: functions[0],
      kind: "function",
    },
  ];
  return (
    <div className="workspace-overview">
      <div className="overview-eyebrow">
        <span>
          <span className="tiny-star">✻</span> THE BIG PICTURE
        </span>
        <div className="scope-toggle" aria-label="Overview source">
          <button
            className={scope === "draft" ? "selected" : ""}
            onClick={() => onScope("draft")}
          >
            Draft
          </button>
          <button
            className={scope === "live" ? "selected" : ""}
            disabled={!installed}
            onClick={() => onScope("live")}
          >
            Live{installed ? ` · v${revision}` : ""}
          </button>
        </div>
      </div>
      <div className="overview-hero">
        <div className="overview-hero-copy">
          <div className="hero-caption">
            A LITTLE APP. A LOT OF POSSIBILITY.
          </div>
          <h1>{manifest.app.name}</h1>
          <p>
            {manifest.app.description ||
              "Your idea, taking shape. Give this app a description in its manifest."}
          </p>
          <button
            onClick={() => openFile("manifest.json")}
            className="hero-link"
          >
            Explore the manifest <ArrowRight size={14} />
          </button>
        </div>
        <div className="app-orbit" aria-hidden="true">
          <div className="orbit-ring orbit-ring-outer" />
          <div className="orbit-ring orbit-ring-inner" />
          <div className="orbit-line orbit-line-one" />
          <div className="orbit-line orbit-line-two" />
          <span className="orbit-node node-top">
            <FileJson2 size={17} />
          </span>
          <span className="orbit-node node-right">
            <Code2 size={17} />
          </span>
          <span className="orbit-node node-bottom">
            <Layers3 size={17} />
          </span>
          <span className="orbit-node node-left">
            <BookOpen size={17} />
          </span>
          <span className="orbit-core">{manifest.app.emoji}</span>
          <span className="orbit-spark">✧</span>
        </div>
      </div>
      <div className="workspace-section-heading">
        <div>
          <h2>The building blocks</h2>
          <p>Real files. One app. All yours.</p>
        </div>
        <span className="section-meta">
          {Object.keys(files).length} SOURCE FILES
        </span>
      </div>
      <div className="building-blocks">
        {buildingBlocks.map((block) => (
          <button
            key={block.name}
            className={`building-block block-${block.color}`}
            onClick={() =>
              block.path ? openFile(block.path) : addFile(block.kind)
            }
          >
            <div>
              <span className="block-icon">
                <block.icon size={18} />
              </span>
              <span className="block-count">{block.count}</span>
            </div>
            <strong>{block.name}</strong>
            <span className="block-detail">
              {block.detail}
              <ArrowRight size={13} />
            </span>
          </button>
        ))}
      </div>
      <div className="overview-columns">
        <section className="overview-section">
          <div className="workspace-section-heading">
            <div>
              <h2>What your agent can do</h2>
              <p>Tools turn your app into useful actions.</p>
            </div>
            <span className="count-bubble">{manifest.tools.length}</span>
          </div>
          {manifest.tools.length ? (
            <div className="tool-list">
              {manifest.tools.map((tool, index) => (
                <div className="overview-tool" key={tool.id ?? index}>
                  <span className="tool-order">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <button
                      className="tool-name"
                      onClick={() => openFile("manifest.json")}
                    >
                      {title(tool.name)}
                      <ArrowRight size={13} />
                    </button>
                    <p>
                      {tool.description || "An action available to your agent."}
                    </p>
                    <div className="tool-connections">
                      {tool.function ? (
                        <button
                          onClick={() =>
                            openFile(
                              manifest.functions.find(
                                (fn) => fn.id === tool.function,
                              )?.entry || "manifest.json",
                            )
                          }
                        >
                          <Code2 size={11} />
                          {manifest.functions.find(
                            (fn) => fn.id === tool.function,
                          )?.name ?? tool.function}
                        </button>
                      ) : (
                        <span>
                          <Database size={11} />
                          {[
                            ...new Set(
                              tool.steps
                                ?.map(
                                  (step) =>
                                    manifest.entities.find(
                                      (e) => e.id === step.entity,
                                    )?.name,
                                )
                                .filter(Boolean),
                            ),
                          ].join(", ") || "Manifest action"}
                        </span>
                      )}
                      {tool.ui?.component && (
                        <>
                          <ArrowRight size={10} />
                          <button
                            onClick={() =>
                              openFile(
                                `ui/components/${tool.ui!.component}.tsx`,
                              )
                            }
                          >
                            <Layers3 size={11} />
                            {tool.ui.component}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <button
              className="overview-empty"
              onClick={() => openFile("manifest.json")}
            >
              <Workflow size={24} />
              <strong>Give your agent something to do</strong>
              <span>
                Define actions in the manifest to expose your app’s
                capabilities.
              </span>
              <span className="inline-action">
                Open manifest <ArrowRight size={12} />
              </span>
            </button>
          )}
        </section>
        <section className="overview-section">
          <div className="workspace-section-heading">
            <div>
              <h2>What it remembers</h2>
              <p>The shape of your app’s data.</p>
            </div>
            <Database size={16} className="text-muted-foreground" />
          </div>
          <div className="entity-cards">
            {manifest.entities.map((entity, index) => (
              <button
                key={entity.id ?? index}
                className="entity-card"
                onClick={() => openFile("manifest.json")}
              >
                <div className="entity-card-title">
                  <span>
                    <Database size={14} />
                    {title(entity.name)}
                  </span>
                  <span>{entity.fields.length} fields</span>
                </div>
                {entity.fields.slice(0, 5).map((field, fieldIndex) => (
                  <div className="entity-field" key={field.id ?? fieldIndex}>
                    <span>
                      {field.name}
                      {field.required && <sup> *</sup>}
                    </span>
                    <span>
                      {field.type === "reference" ? (
                        <>
                          <Link2 size={10} />
                          {manifest.entities.find((e) => e.id === field.target)
                            ?.name ?? "reference"}
                        </>
                      ) : (
                        field.type
                      )}
                    </span>
                  </div>
                ))}
                {entity.fields.length > 5 && (
                  <span className="more-fields">
                    + {entity.fields.length - 5} more fields
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      </div>
      <section className="overview-section">
        <div className="workspace-section-heading">
          <div>
            <h2>A mind of its own. Your instructions.</h2>
            <p>
              Skills give your agent context, judgment, and a way of working.
            </p>
          </div>
          <button className="subtle-button" onClick={() => addFile("skill")}>
            <Plus size={13} /> Add skill
          </button>
        </div>
        <div className="skill-cards">
          {skills.length ? (
            skills.map((path) => (
              <button
                key={path}
                className="skill-card"
                onClick={() => openFile(path)}
              >
                <span className="skill-card-icon">
                  <BookOpen size={19} />
                </span>
                <div>
                  <strong>{title(fileLabel(path).replaceAll("-", " "))}</strong>
                  <p>{skillDescription(files[path])}</p>
                  <code>{path}</code>
                </div>
                <ArrowRight size={16} />
              </button>
            ))
          ) : (
            <button
              className="skill-card empty-skill"
              onClick={() => addFile("skill")}
            >
              <BookOpen size={22} />
              <div>
                <strong>Teach your agent how you work</strong>
                <p>
                  Add a Markdown skill. A few thoughtful instructions go a long
                  way.
                </p>
              </div>
              <Plus size={16} />
            </button>
          )}
        </div>
      </section>
      {manifest.functions.length > 0 && (
        <section className="overview-section">
          <div className="workspace-section-heading">
            <div>
              <h2>The logic behind the action</h2>
              <p>Functions extend what your app can do.</p>
            </div>
            <Braces size={17} />
          </div>
          <div className="function-cards">
            {manifest.functions.map((fn, index) => (
              <button
                className="function-card"
                key={fn.id ?? index}
                onClick={() => openFile(fn.entry)}
              >
                <span className="function-icon">
                  <Code2 size={17} />
                </span>
                <div>
                  <strong>{fn.name}</strong>
                  <code>{fn.entry}</code>
                </div>
                <span className="language-tag">{fn.runtime ?? "wasm"}</span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="capability-card">
        <ShieldCheck size={21} />
        <div>
          <strong>Clear boundaries. Confident building.</strong>
          <p>
            {network.length || hasModel || dataGrants.length
              ? "Functions can use only the capabilities declared in the manifest."
              : "This app’s functions have no external access. Capabilities are declared in the manifest and enforced at runtime."}
          </p>
          <div className="capability-chips">
            {network.map((host) => (
              <span key={host}>
                <Network size={11} />
                {host}
              </span>
            ))}
            {hasModel && (
              <span>
                <Sparkles size={11} />
                Model access
              </span>
            )}
            {dataGrants.map((grant, i) => (
              <span key={i}>
                <Database size={11} />
                {manifest.entities.find((e) => e.id === grant.entity)?.name ??
                  grant.entity}
                :{" "}
                {Array.isArray(grant.operations)
                  ? grant.operations.join(", ")
                  : ""}
              </span>
            ))}
          </div>
        </div>
        <button
          onClick={() => openFile("manifest.json")}
          aria-label="View app capabilities"
        >
          <ArrowRight size={15} />
        </button>
      </div>
      <div className="overview-footer">
        <span>Built with intention. Changed with confidence.</span>
        <span>
          OPEN WORKBENCH <ArrowDown size={11} />
        </span>
      </div>
    </div>
  );
}
