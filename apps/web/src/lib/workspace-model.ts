export interface ManifestField {
  id: string;
  name: string;
  type: string;
  required?: boolean;
  values?: string[];
  target?: string;
}
export interface ManifestEntity {
  id: string;
  name: string;
  fields: ManifestField[];
}
export interface ManifestTool {
  id: string;
  name: string;
  description?: string;
  function?: string;
  ui?: { component: string };
  steps?: { entity?: string; op?: string }[];
}
export interface ManifestFunction {
  id: string;
  name: string;
  entry: string;
  runtime?: string;
  capabilities?: {
    network?: string[];
    model?: boolean;
    data?: { entity: string; operations: string[] }[];
  };
}
export interface AppManifest {
  app: {
    id?: string;
    name: string;
    description: string;
    emoji: string;
    color: string;
    version?: number;
  };
  entities: ManifestEntity[];
  tools: ManifestTool[];
  functions: ManifestFunction[];
}
const objects = <T>(value: unknown): T[] =>
  Array.isArray(value)
    ? value.filter((v) => v && typeof v === "object" && !Array.isArray(v))
    : [];
export function parseAppManifest(source: string): AppManifest | null {
  try {
    const raw = JSON.parse(source);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const text = (value: unknown, fallback = "") =>
      typeof value === "string" ? value : fallback;
    return {
      app: {
        id: text(raw.app?.id),
        name: text(raw.app?.name, "Untitled app"),
        description: text(raw.app?.description),
        emoji: text(raw.app?.emoji, "✳"),
        color: /^#[\da-f]{3,8}$/i.test(raw.app?.color ?? "")
          ? raw.app.color
          : "#61754e",
        version: raw.app?.version,
      },
      entities: objects<ManifestEntity>(raw.entities).map((e) => ({
        ...e,
        name: text(e.name, "Unnamed entity"),
        fields: objects<ManifestField>(e.fields).map((f) => ({
          ...f,
          name: text(f.name, "Unnamed field"),
          type: text(f.type, "unknown"),
        })),
      })),
      tools: objects<ManifestTool>(raw.tools).map((t) => ({
        ...t,
        name: text(t.name, "Unnamed tool"),
        description: text(t.description),
        steps: objects(t.steps),
      })),
      functions: objects<ManifestFunction>(raw.functions).map((f) => ({
        ...f,
        name: text(f.name, "Unnamed function"),
        entry: text(f.entry),
      })),
    };
  } catch {
    return null;
  }
}
export function sourceLanguage(path: string) {
  return path.endsWith(".md")
    ? "markdown"
    : path.endsWith(".tsx") || path.endsWith(".ts")
      ? "typescript"
      : path.endsWith(".py")
        ? "python"
        : "json";
}
export function fileLabel(path: string) {
  return path.endsWith("SKILL.md")
    ? path.split("/")[1]
    : (path.split("/").at(-1) ?? path);
}
export function relativeDate(at: string) {
  const delta = Date.now() - new Date(at).getTime();
  if (delta < 60000) return "Just now";
  if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`;
  if (delta < 86400000) return `${Math.floor(delta / 3600000)}h ago`;
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
