import { useEffect, useRef, useState } from "react";
import {
  Code2,
  Layers3,
  LoaderCircle,
  Monitor,
  Play,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import { previewWorkspace, type WorkspaceProject } from "@/lib/workspace-api";
import type { AppManifest } from "@/lib/workspace-model";
import { Button } from "@/components/ui/button";

function sampleProps(manifest: AppManifest) {
  const row: Record<string, unknown> = {
    id: "preview_01",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  for (const entity of manifest.entities)
    for (const field of entity.fields) {
      row[field.name] =
        field.type === "enum"
          ? field.values?.[0]
          : field.type === "boolean"
            ? true
            : field.type === "integer"
              ? 3
              : field.type === "real"
                ? 12.5
                : field.type === "datetime"
                  ? new Date().toISOString()
                  : field.name === "title" || field.name === "name"
                    ? "Make room for a good idea"
                    : field.name === "notes"
                      ? "A small step with a meaningful result."
                      : field.name === "url"
                        ? "https://example.com"
                        : `Sample ${field.name.replaceAll("_", " ")}`;
    }
  return { ...row, items: [row], rows: [row], data: [row] };
}

export function ComponentPreview({
  project,
  manifest,
  flush,
  openFile,
}: {
  project: WorkspaceProject;
  manifest: AppManifest;
  flush: () => Promise<WorkspaceProject>;
  openFile: (path: string) => void;
}) {
  const components = Object.keys(project.files)
    .filter((path) => path.endsWith(".tsx"))
    .map((path) => path.split("/").at(-1)!.replace(".tsx", ""));
  const [component, setComponent] = useState(components[0] ?? "");
  const [props, setProps] = useState(() =>
    JSON.stringify(sampleProps(manifest), null, 2),
  );
  const [html, setHtml] = useState("");
  const [builtVersion, setBuiltVersion] = useState(0);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState("");
  const [device, setDevice] = useState("desktop");
  const iframe = useRef<HTMLIFrameElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [propsError, setPropsError] = useState("");
  const sendProps = () => {
    try {
      const parsed = JSON.parse(propsRef.current);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Props must be a JSON object.");
      iframe.current?.contentWindow?.postMessage(
        { type: "workbench:preview-props", props: parsed },
        "*",
      );
      setPropsError("");
    } catch (error) {
      setPropsError((error as Error).message);
    }
  };
  useEffect(() => {
    const ready = (event: MessageEvent) => {
      if (
        event.source === iframe.current?.contentWindow &&
        event.data?.type === "workbench:preview-ready"
      )
        sendProps();
    };
    window.addEventListener("message", ready);
    return () => window.removeEventListener("message", ready);
  }, []);
  useEffect(() => {
    if (html) sendProps();
  }, [props, html]);
  const build = async () => {
    setBuilding(true);
    setError("");
    try {
      const current = await flush();
      const preview = await previewWorkspace(
        current.id,
        current.version,
        component,
      );
      setHtml(preview.html);
      setBuiltVersion(preview.version);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBuilding(false);
    }
  };
  if (!components.length)
    return (
      <div className="workspace-empty-state">
        <span className="large-empty-icon">
          <Layers3 size={30} />
        </span>
        <h2>Give your app a face.</h2>
        <p>
          React components turn tool results into something useful to look at.
          Add a component in the explorer to preview it here.
        </p>
        <Button variant="outline" onClick={() => openFile("manifest.json")}>
          <Code2 size={14} /> Explore the manifest
        </Button>
      </div>
    );
  return (
    <div className="component-preview">
      <div className="preview-heading">
        <div>
          <span className="eyebrow">THE PLAYGROUND</span>
          <h1>See it take shape.</h1>
          <p>Your React components, with sample data you control.</p>
        </div>
      </div>
      <div className="preview-controls">
        <label>
          <Layers3 size={14} />
          <select
            aria-label="Preview component"
            value={component}
            onChange={(event) => {
              setComponent(event.target.value);
              setHtml("");
              setBuiltVersion(0);
            }}
          >
            {components.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <div className="device-toggle">
          <button
            className={device === "desktop" ? "selected" : ""}
            onClick={() => setDevice("desktop")}
            aria-label="Desktop preview"
          >
            <Monitor size={14} />
          </button>
          <button
            className={device === "mobile" ? "selected" : ""}
            onClick={() => setDevice("mobile")}
            aria-label="Mobile preview"
          >
            <Smartphone size={14} />
          </button>
        </div>
        <Button
          size="sm"
          disabled={building || project.busy}
          onClick={() => void build()}
        >
          {building ? (
            <LoaderCircle className="animate-spin" />
          ) : html ? (
            <RefreshCw />
          ) : (
            <Play />
          )}
          {building ? "Building…" : html ? "Rebuild preview" : "Build preview"}
        </Button>
      </div>
      {error && (
        <div className="workspace-error" role="alert">
          {error}
        </div>
      )}
      <div className="preview-stage">
        <div
          className={`preview-browser ${device === "mobile" ? "preview-mobile" : ""}`}
        >
          <div className="preview-browser-chrome">
            <span />
            <span />
            <span />
            <code>{component}.tsx</code>
            <span className="preview-sample-label">SAMPLE DATA</span>
          </div>
          {html ? (
            <iframe
              ref={iframe}
              sandbox="allow-scripts"
              srcDoc={html}
              title={`${component} component preview`}
              onLoad={sendProps}
            />
          ) : (
            <div className="preview-placeholder">
              <span className="preview-placeholder-icon">
                <Layers3 size={29} />
              </span>
              <h3>
                {building
                  ? "A little compiling magic…"
                  : "A window into your app."}
              </h3>
              <p>
                {building
                  ? "Checking types and building your component."
                  : "Build a preview to render this component with sample inputs."}
              </p>
              {building && <LoaderCircle size={20} className="animate-spin" />}
            </div>
          )}
        </div>
      </div>
      <div className="preview-data">
        <div>
          <h2>Try different inputs</h2>
          <p>
            Edit the JSON to see how your component responds. This stays
            separate from your live data.
          </p>
          {builtVersion > 0 && (
            <span className="preview-version">
              {builtVersion === project.version
                ? "Preview is up to date"
                : "Source changed · rebuild to update"}
            </span>
          )}
          <button
            className="subtle-button"
            onClick={() => openFile(`ui/components/${component}.tsx`)}
          >
            <Code2 size={13} /> Edit component
          </button>
        </div>
        <div>
          <textarea
            aria-label="Preview sample props"
            spellCheck={false}
            value={props}
            onChange={(event) => setProps(event.target.value)}
          />
          {propsError && (
            <p className="text-sm text-destructive">{propsError}</p>
          )}
        </div>
      </div>
    </div>
  );
}
