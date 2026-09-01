import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

interface ManifestField {
  name: string
  type: string
  required?: boolean
  values?: string[]
}

interface ManifestEntity {
  name: string
  fields?: ManifestField[]
}

interface Manifest {
  entities?: ManifestEntity[]
}

function pascalCase(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("")
}

function fieldType(field: ManifestField): string {
  switch (field.type) {
    case "text":
    case "datetime":
    case "reference":
      return "string"
    case "enum":
      return field.values && field.values.length > 0 ? field.values.map((v) => JSON.stringify(v)).join(" | ") : "string"
    case "integer":
    case "real":
      return "number"
    case "boolean":
      return "boolean"
    default:
      return "unknown"
  }
}

/**
 * Emits one TS interface per manifest entity into ui/generated/entities.d.ts,
 * so an agent-written component (e.g. ui/components/Workout.tsx) types its
 * props against the real schema instead of guessing field names. Every
 * entity gets the platform's own id/created_at/updated_at columns in
 * addition to its declared fields, matching what a tool call actually
 * returns (see engine/domain's row shape).
 */
export function generateEntityTypes(manifestPath: string, outPath: string): void {
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
  const entities = manifest.entities ?? []

  const lines: string[] = ["// Generated from manifest.json entities -- do not edit by hand.", ""]
  for (const entity of entities) {
    lines.push(`export interface ${pascalCase(entity.name)} {`)
    lines.push("  id: string")
    for (const field of entity.fields ?? []) {
      lines.push(`  ${field.name}${field.required ? "" : "?"}: ${fieldType(field)}`)
    }
    lines.push("  created_at: string")
    lines.push("  updated_at: string")
    lines.push("}")
    lines.push("")
  }

  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, lines.join("\n"), "utf-8")
}
