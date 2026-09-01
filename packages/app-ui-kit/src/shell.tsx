import { createRoot } from "react-dom/client"
import { App } from "@modelcontextprotocol/ext-apps"
import type { ComponentType } from "react"

// No CSS import here -- build/build-app-ui.ts generates and imports a
// per-build entry stylesheet that pulls in theme.css with the right
// Tailwind @source directives for that specific app. See theme.css's own
// header comment for why.

interface MountOptions {
  /** The component's own name, e.g. "Workout" — becomes the MCP App's identity. */
  name: string
  version?: string
}

/**
 * Generic MCP Apps bootstrap, shared by every built component — never
 * agent-authored. Connects to the host, then re-renders `Component` each
 * time the host pushes a fresh tool result, passing that result's data
 * straight through as props.
 */
export function mountAppComponent(Component: ComponentType<Record<string, unknown>>, options: MountOptions) {
  const container = document.getElementById("root")
  if (!container) throw new Error("app-ui-kit shell: #root element missing")
  const root = createRoot(container)

  const app = new App({ name: options.name, version: options.version ?? "1.0.0" })

  app.ontoolresult = (notification: unknown) => {
    root.render(<Component {...extractProps(notification)} />)
  }

  app.connect().catch((err: unknown) => {
    root.render(
      <pre style={{ padding: 16, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
        Failed to connect to host: {String(err)}
      </pre>,
    )
  })
}

/**
 * Pulls plain data out of a pushed tool result for use as component props.
 * Defensive about shape: the documented `ontoolresult` payload type
 * (ToolResultNotification) isn't fully nailed down in the extension's public
 * docs at time of writing, so this accepts either the CallToolResult
 * directly or a `{ result: CallToolResult }` wrapper around it.
 */
function extractProps(notification: unknown): Record<string, unknown> {
  if (!notification || typeof notification !== "object") return {}
  const n = notification as Record<string, unknown>
  const result = (n.result && typeof n.result === "object" ? n.result : n) as Record<string, unknown>

  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>
  }
  const content = result.content
  if (Array.isArray(content)) {
    const text = content.find((c) => c && typeof c === "object" && (c as { type?: string }).type === "text") as
      | { text?: string }
      | undefined
    if (typeof text?.text === "string") {
      try {
        const parsed = JSON.parse(text.text)
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
      } catch {
        // Not JSON -- fall through to the empty-props default below.
      }
    }
  }
  return {}
}
