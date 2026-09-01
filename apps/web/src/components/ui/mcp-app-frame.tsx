import { useEffect, useRef, useState } from "react"
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge"

import { callAppMcpTool, fetchAppMcpResource } from "@/lib/api"
import { cn } from "@/lib/utils"

interface McpAppFrameProps {
  /** The installed app whose MCP server owns this resource. */
  appId: string
  /** The tool's declared `_meta.ui.resourceUri`, e.g. "ui://reading_tracker/Book.html". */
  resourceUri: string
  /** The triggering tool call's own result -- pushed into the view once it signals ready. */
  toolResult: unknown
  className?: string
}

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; html: string }

/**
 * Renders one MCP Apps component: fetches its resource HTML through this
 * app's own MCP server (proxied via the runtime, never reached directly —
 * same boundary every other app-scoped fetch in this codebase already
 * respects), then mounts it in a sandboxed iframe and wires the App Bridge
 * so it receives the triggering tool's result and can call tools back.
 */
const MIN_FRAME_HEIGHT = 80
const MAX_FRAME_HEIGHT = 2000

function McpAppFrame({ appId, resourceUri, toolResult, className }: McpAppFrameProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" })
  const [frameHeight, setFrameHeight] = useState<number | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setState({ kind: "loading" })
    setFrameHeight(null)
    fetchAppMcpResource(appId, resourceUri)
      .then((body) => {
        const html = body.contents?.[0]?.text
        if (typeof html !== "string") throw new Error("Component resource had no HTML content")
        if (!cancelled) setState({ kind: "ready", html })
      })
      .catch((error) => {
        if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [appId, resourceUri])

  useEffect(() => {
    if (state.kind !== "ready") return
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return

    const bridge = new AppBridge(null, { name: "Open Workbench", version: "0.1.0" }, { serverTools: {}, logging: {} })
    bridge.oninitialized = () => {
      bridge.sendToolResult(toolResult as Parameters<typeof bridge.sendToolResult>[0])
    }
    type CallToolResult = Awaited<ReturnType<NonNullable<AppBridge["oncalltool"]>>>
    bridge.oncalltool = async (params) => {
      const result = await callAppMcpTool(appId, params.name, params.arguments)
      return result as CallToolResult
    }
    bridge.addEventListener("sizechange", ({ height }) => {
      if (typeof height === "number") setFrameHeight(Math.min(Math.max(height, MIN_FRAME_HEIGHT), MAX_FRAME_HEIGHT))
    })

    const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow)
    bridge.connect(transport).catch((error) => {
      console.error("[mcp-app-frame] bridge connect failed", error)
    })

    return () => {
      bridge.close().catch(() => {})
    }
    // toolResult intentionally excluded: a fresh tool_end for the same widget
    // re-renders this component with a new key upstream rather than pushing
    // into an already-connected bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, appId])

  if (state.kind === "error") {
    return (
      <div className={cn("rounded-lg border border-destructive/40 bg-card p-3 text-sm text-destructive", className)}>
        {state.message}
      </div>
    )
  }

  if (state.kind === "loading") {
    return <div className={cn("h-24 animate-pulse rounded-lg border border-border bg-card", className)} />
  }

  return (
    <iframe
      ref={iframeRef}
      title="App component"
      sandbox="allow-scripts"
      srcDoc={state.html}
      style={frameHeight != null ? { height: frameHeight } : undefined}
      className={cn("w-full rounded-lg border border-border bg-card", frameHeight == null && "h-64", className)}
    />
  )
}

export { McpAppFrame }
