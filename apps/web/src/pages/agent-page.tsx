import { useEffect, useRef, useState } from "react"
import { Sparkles } from "lucide-react"

import { fetchApps, fetchModels, streamChat, switchModel, type AgentStreamEvent, type AppInfo, type ModelInfo } from "@/lib/api"
import { PageHeader } from "@/components/shell/page-header"
import {
  Conversation,
  Message,
  MessageAvatar,
  MessageContent,
  MessageMeta,
  MessageActionsDefault,
} from "@/components/ui/chat"
import { Doodle } from "@/components/ui/doodle"
import {
  PromptInput,
  PromptInputSend,
  PromptInputTextarea,
  PromptInputToolbar,
  Suggestion,
  Suggestions,
} from "@/components/ui/prompt-input"
import { Markdown } from "@/components/ui/markdown"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StreamingCaret } from "@/components/ui/streaming"
import { Thinking } from "@/components/ui/thinking"
import { ToolCall, ToolCallArgs, ToolCallPanel } from "@/components/ui/tool-call"
import { Heading, Muted } from "@/components/ui/typography"

type Segment =
  | { kind: "thinking"; text: string; streaming: boolean; startedAt: number; durationMs?: number }
  | {
      kind: "tool"
      toolCallId: string
      toolName: string
      args: unknown
      status: "running" | "success" | "error"
      startedAt: number
      durationMs?: number
    }
  | { kind: "text"; text: string }

type Turn =
  | { id: string; role: "user"; text: string }
  | {
      id: string
      role: "assistant"
      segments: Segment[]
      streaming: boolean
      error?: string
      startedAt: number
      finishedAt?: number
    }

const SUGGESTIONS = [
  "What apps do you have access to?",
  "What can you help me with?",
  "List everything you can do right now.",
]

/** Folds one stream event into a turn's segments, closing any open reasoning block along the way. */
function appendEvent(segments: Segment[], event: AgentStreamEvent): Segment[] {
  if (event.type === "thinking") {
    const last = segments[segments.length - 1]
    if (last?.kind === "thinking" && last.streaming) {
      return [...segments.slice(0, -1), { ...last, text: last.text + event.delta }]
    }
    return [...segments, { kind: "thinking", text: event.delta, streaming: true, startedAt: Date.now() }]
  }

  const withClosedThinking = segments.map((s) =>
    s.kind === "thinking" && s.streaming ? { ...s, streaming: false, durationMs: Date.now() - s.startedAt } : s,
  )

  if (event.type === "text") {
    const last = withClosedThinking[withClosedThinking.length - 1]
    if (last?.kind === "text") {
      return [...withClosedThinking.slice(0, -1), { ...last, text: last.text + event.delta }]
    }
    return [...withClosedThinking, { kind: "text", text: event.delta }]
  }

  if (event.type === "tool_start") {
    return [
      ...withClosedThinking,
      {
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        status: "running",
        startedAt: Date.now(),
      },
    ]
  }

  if (event.type === "tool_end") {
    return withClosedThinking.map((s) =>
      s.kind === "tool" && s.toolCallId === event.toolCallId
        ? { ...s, status: event.isError ? "error" : "success", durationMs: Date.now() - s.startedAt }
        : s,
    )
  }

  return withClosedThinking
}

function toArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {}
  return value as Record<string, unknown>
}

/**
 * Every app/tool call goes through a single proxy tool named "mcp" (its
 * action lives in the arguments, not the tool name) — show what it's
 * actually doing instead of the literal, unhelpful "mcp" for every call.
 */
function toolCallLabel(toolName: string, args: unknown): string {
  if (toolName !== "mcp" || !args || typeof args !== "object") return toolName
  const a = args as Record<string, unknown>
  if (typeof a.tool === "string") return typeof a.server === "string" ? `${a.server}.${a.tool}` : a.tool
  if (typeof a.describe === "string") return `mcp.describe(${a.describe})`
  if (typeof a.search === "string") return `mcp.search("${a.search}")`
  if (typeof a.server === "string") return `mcp.list(${a.server})`
  return "mcp.servers"
}

type ToolSegment = Extract<Segment, { kind: "tool" }>
type NonToolSegment = Exclude<Segment, { kind: "tool" }>
type RenderItem = { kind: "single"; segment: NonToolSegment } | { kind: "tool-group"; items: ToolSegment[] }

/** Collapses runs of consecutive tool calls (e.g. 10 add_exercise calls in a row) into one group. */
function groupSegments(segments: Segment[]): RenderItem[] {
  const items: RenderItem[] = []
  for (const segment of segments) {
    const last = items[items.length - 1]
    if (segment.kind === "tool" && last?.kind === "tool-group") {
      last.items.push(segment)
      continue
    }
    if (segment.kind === "tool") {
      items.push({ kind: "tool-group", items: [segment] })
      continue
    }
    items.push({ kind: "single", segment })
  }
  return items
}

function toolGroupLabel(items: ToolSegment[]): string {
  const labels = new Set(items.map((s) => toolCallLabel(s.toolName, s.args)))
  if (labels.size === 1) return `${items.length} × ${[...labels][0]}`
  return `${items.length} tool calls`
}

function toolGroupStatus(items: ToolSegment[]): "running" | "success" | "error" {
  if (items.some((s) => s.status === "running")) return "running"
  if (items.some((s) => s.status === "error")) return "error"
  return "success"
}

function newId() {
  return Math.random().toString(36).slice(2)
}

function AgentPage() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [currentModel, setCurrentModel] = useState<string>("")
  const [apps, setApps] = useState<AppInfo[]>([])
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    fetchModels()
      .then(({ models, current }) => {
        setModels(models)
        setCurrentModel(current)
      })
      .catch(() => {})
    fetchApps()
      .then(({ apps }) => setApps(apps))
      .catch(() => {})
  }, [])

  const updateLastAssistant = (fn: (turn: Turn & { role: "assistant" }) => Turn) => {
    setTurns((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last?.role === "assistant") next[next.length - 1] = fn(last)
      return next
    })
  }

  const send = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || streaming) return

    setDraft("")
    setStreaming(true)
    setTurns((prev) => [
      ...prev,
      { id: newId(), role: "user", text: trimmed },
      { id: newId(), role: "assistant", segments: [], streaming: true, startedAt: Date.now() },
    ])

    const controller = new AbortController()
    abortRef.current = controller

    streamChat(
      trimmed,
      (event) => {
        if (event.type === "done") {
          updateLastAssistant((turn) => ({ ...turn, streaming: false, finishedAt: Date.now() }))
          return
        }
        if (event.type === "error") {
          updateLastAssistant((turn) => ({ ...turn, streaming: false, finishedAt: Date.now(), error: event.reason }))
          return
        }
        updateLastAssistant((turn) => ({ ...turn, segments: appendEvent(turn.segments, event) }))
      },
      controller.signal,
    )
      .catch((error) => {
        updateLastAssistant((turn) => ({
          ...turn,
          streaming: false,
          finishedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }))
      })
      .finally(() => setStreaming(false))
  }

  const stop = () => abortRef.current?.abort()

  return (
    <>
      <PageHeader breadcrumb="AGENT · CHAT">
        <Select
          value={currentModel}
          onValueChange={(value) => {
            setCurrentModel(value)
            switchModel(value).catch(() => {})
          }}
          disabled={streaming || models.length === 0}
        >
          <SelectTrigger className="h-8 w-auto gap-1.5 rounded-full border-border bg-card px-3 font-mono text-[0.625rem] tracking-[0.12em] uppercase">
            <Sparkles className="size-3 text-accent" />
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageHeader>

      <Conversation stickToBottom className="flex-1 px-6 py-6 sm:px-10">
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
            <Doodle name="sprout" className="size-12 text-fern-400" />
            <div>
              <Heading level="h2">What should we work on?</Heading>
              <Muted className="mt-2">
                {apps.length === 0
                  ? "No apps are installed yet — the agent can still help with anything general."
                  : `${apps.length === 1 ? "One app is" : `${apps.length} apps are`} installed. Your agent reaches for ${apps.length === 1 ? "it" : "them"} on its own — no need to say which.`}
              </Muted>
            </div>
            <Suggestions className="max-w-md justify-center">
              {SUGGESTIONS.map((suggestion) => (
                <Suggestion key={suggestion} onClick={() => setDraft(suggestion)}>
                  {suggestion}
                </Suggestion>
              ))}
            </Suggestions>
          </div>
        ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {turns.map((turn) =>
            turn.role === "user" ? (
              <Message key={turn.id} role="user">
                <MessageAvatar role="user" />
                <MessageContent role="user">
                  <p>{turn.text}</p>
                </MessageContent>
              </Message>
            ) : (
              <Message key={turn.id} role="assistant" className="group/message">
                <MessageAvatar />
                <MessageContent>
                  {groupSegments(turn.segments).map((item, index, all) => {
                    if (item.kind === "tool-group") {
                      if (item.items.length === 1) {
                        const segment = item.items[0]
                        return (
                          <ToolCall
                            key={segment.toolCallId}
                            className="mt-3"
                            name={toolCallLabel(segment.toolName, segment.args)}
                            status={segment.status}
                            duration={segment.durationMs != null ? `${(segment.durationMs / 1000).toFixed(1)}s` : undefined}
                          >
                            <ToolCallPanel label="Arguments">
                              <ToolCallArgs args={toArgs(segment.args)} />
                            </ToolCallPanel>
                          </ToolCall>
                        )
                      }
                      const first = item.items[0]
                      const lastCall = item.items[item.items.length - 1]
                      const allDone = item.items.every((s) => s.durationMs != null)
                      return (
                        <ToolCall
                          key={first.toolCallId}
                          className="mt-3"
                          name={toolGroupLabel(item.items)}
                          status={toolGroupStatus(item.items)}
                          duration={
                            allDone
                              ? `${((lastCall.startedAt + (lastCall.durationMs ?? 0) - first.startedAt) / 1000).toFixed(1)}s`
                              : undefined
                          }
                        >
                          <ToolCallPanel label={`${item.items.length} calls`}>
                            <div className="flex flex-col gap-2">
                              {item.items.map((segment) => (
                                <ToolCall
                                  key={segment.toolCallId}
                                  name={toolCallLabel(segment.toolName, segment.args)}
                                  status={segment.status}
                                  duration={segment.durationMs != null ? `${(segment.durationMs / 1000).toFixed(1)}s` : undefined}
                                >
                                  <ToolCallPanel label="Arguments">
                                    <ToolCallArgs args={toArgs(segment.args)} />
                                  </ToolCallPanel>
                                </ToolCall>
                              ))}
                            </div>
                          </ToolCallPanel>
                        </ToolCall>
                      )
                    }

                    const segment = item.segment
                    if (segment.kind === "thinking") {
                      return (
                        <Thinking
                          key={index}
                          streaming={segment.streaming}
                          duration={segment.durationMs != null ? Math.round(segment.durationMs / 1000) : undefined}
                        >
                          <p>{segment.text}</p>
                        </Thinking>
                      )
                    }
                    const isLast = index === all.length - 1
                    return (
                      <span key={index} className="block">
                        <Markdown content={segment.text} />
                        {turn.streaming && isLast ? <StreamingCaret /> : null}
                      </span>
                    )
                  })}

                  {turn.error ? <p className="mt-3 text-sm text-destructive">{turn.error}</p> : null}

                  {!turn.streaming && !turn.error && turn.segments.length > 0 ? (
                    <>
                      <MessageMeta>
                        {[
                          "WORKBENCH AGENT",
                          turn.finishedAt ? new Date(turn.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null,
                          turn.finishedAt ? `${((turn.finishedAt - turn.startedAt) / 1000).toFixed(1)}S` : null,
                          (() => {
                            const n = turn.segments.filter((s) => s.kind === "tool").length
                            return n > 0 ? `${n} TOOL${n === 1 ? "" : "S"}` : null
                          })(),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </MessageMeta>
                      <MessageActionsDefault
                        content={turn.segments
                          .filter((s) => s.kind === "text")
                          .map((s) => (s as { text: string }).text)
                          .join("\n")}
                      />
                    </>
                  ) : null}
                </MessageContent>
              </Message>
            ),
          )}
        </div>
        )}
      </Conversation>

      <div className="border-t border-border bg-background/40 px-6 py-4 sm:px-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col">
          <PromptInput
            onSubmit={(event) => {
              event.preventDefault()
              send(draft)
            }}
          >
            <PromptInputTextarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onSubmitMessage={() => send(draft)}
              placeholder="Ask your agent anything…"
            />
            <PromptInputToolbar>
              <PromptInputSend streaming={streaming} onStop={stop} disabled={!draft.trim()} />
            </PromptInputToolbar>
          </PromptInput>

          {apps.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-muted-foreground/70">
                In context
              </span>
              {apps.map((app) => (
                <span
                  key={app.id}
                  className="rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-muted-foreground"
                >
                  {app.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

export { AgentPage }
