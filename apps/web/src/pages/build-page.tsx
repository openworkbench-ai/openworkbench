import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"

import {
  answerBuildQuestions,
  fetchBuildDraft,
  installBuildDraft,
  streamBuildChat,
  type AgentStreamEvent,
  type AppDraft,
  type AskQuestion,
  type PlanStep,
} from "@/lib/api"
import { PageHeader } from "@/components/shell/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Conversation,
  Message,
  MessageAvatar,
  MessageContent,
  MessageMeta,
  MessageActionsDefault,
} from "@/components/ui/chat"
import { Doodle } from "@/components/ui/doodle"
import { Input } from "@/components/ui/input"
import { Markdown } from "@/components/ui/markdown"
import {
  PromptInput,
  PromptInputSend,
  PromptInputTextarea,
  PromptInputToolbar,
} from "@/components/ui/prompt-input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { StreamingCaret } from "@/components/ui/streaming"
import { TaskItem, TaskList } from "@/components/ui/task-list"
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
  | { kind: "plan"; steps: PlanStep[] }
  | { kind: "question"; toolCallId: string; questions: AskQuestion[] }
  | { kind: "app-preview"; toolCallId: string; appId: string }

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

/** Folds one build-chat stream event into a turn's segments — same shape as the chat agent's, plus
 * two build-specific tool calls that get their own presentation instead of a generic tool-call panel:
 * `update_plan` (rendered as a single, always-latest checklist) and `ask_questions` (an inline form). */
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
    if (event.toolName === "update_plan") {
      const steps = (event.args as { steps?: PlanStep[] } | undefined)?.steps ?? []
      const planSegment: Segment = { kind: "plan", steps }
      const planIndex = withClosedThinking.findIndex((s) => s.kind === "plan")
      if (planIndex === -1) return [...withClosedThinking, planSegment]
      const next = [...withClosedThinking]
      next[planIndex] = planSegment
      return next
    }
    if (event.toolName === "ask_questions") {
      const questions = (event.args as { questions?: AskQuestion[] } | undefined)?.questions ?? []
      return [...withClosedThinking, { kind: "question", toolCallId: event.toolCallId, questions }]
    }
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
    const mapped: Segment[] = withClosedThinking.map((s) =>
      s.kind === "tool" && s.toolCallId === event.toolCallId
        ? { ...s, status: event.isError ? "error" : "success", durationMs: Date.now() - s.startedAt }
        : s,
    )
    if (event.toolName === "present_app" && !event.isError) {
      const toolSegment = mapped.find(
        (s): s is ToolSegment => s.kind === "tool" && s.toolCallId === event.toolCallId,
      )
      const appId = (toolSegment?.args as { id?: string } | undefined)?.id
      if (appId) return [...mapped, { kind: "app-preview", toolCallId: event.toolCallId, appId }]
    }
    return mapped
  }

  return withClosedThinking
}

function toArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {}
  return value as Record<string, unknown>
}

type ToolSegment = Extract<Segment, { kind: "tool" }>
type SingleSegment = Exclude<Segment, { kind: "tool" }>
type RenderItem = { kind: "single"; segment: SingleSegment } | { kind: "tool-group"; items: ToolSegment[] }

/** Collapses runs of consecutive plain tool calls (e.g. several `edit` calls in a row) into one group. */
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
  const names = new Set(items.map((s) => s.toolName))
  if (names.size === 1) return `${items.length} × ${[...names][0]}`
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

/** The agent's checklist for this build, kept in one place and always showing its latest state. */
function PlanCard({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return null
  return (
    <Card className="mt-3">
      <CardContent className="p-4">
        <TaskList>
          {steps.map((step) => (
            <TaskItem key={step.id} state={step.status}>
              {step.label}
            </TaskItem>
          ))}
        </TaskList>
      </CardContent>
    </Card>
  )
}

/**
 * Reduces one option to a plain, renderable label. The agent's tool-call args are model output, not
 * schema-enforced at runtime -- an option can arrive as something other than a string (e.g. an
 * `{id, name, description}` object), so this never assumes the declared shape held.
 */
function optionLabel(option: unknown): string {
  if (typeof option === "string") return option
  if (option && typeof option === "object") {
    const o = option as Record<string, unknown>
    for (const key of ["name", "label", "value", "id"]) {
      if (typeof o[key] === "string") return o[key] as string
    }
  }
  return JSON.stringify(option)
}

function isAnswered(question: AskQuestion, answer: string | string[] | undefined): boolean {
  if (question.type === "multiple_choice") return Array.isArray(answer) && answer.length > 0
  return typeof answer === "string" && answer.trim().length > 0
}

/** One question per open design decision -- single_choice, multiple_choice, or free_text -- submitted together and then frozen. */
function QuestionForm({ toolCallId, questions }: { toolCallId: string; questions: AskQuestion[] }) {
  const [selections, setSelections] = useState<Record<string, string | string[]>>({})
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allAnswered = questions.every((q) => isAnswered(q, selections[q.id]))

  const submit = async () => {
    if (!allAnswered || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await answerBuildQuestions(
        toolCallId,
        questions.map((q) => ({ id: q.id, answer: selections[q.id] ?? (q.type === "multiple_choice" ? [] : "") })),
      )
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="mt-3">
      <CardContent className="flex flex-col gap-5 p-4">
        {questions.map((question) => {
          const options = question.options ?? []
          return (
            <div key={question.id} className="flex flex-col gap-2">
              <p className="text-sm font-medium text-foreground">{optionLabel(question.question)}</p>

              {question.type === "single_choice" ? (
                <RadioGroup
                  value={(selections[question.id] as string) ?? ""}
                  onValueChange={(value) => setSelections((prev) => ({ ...prev, [question.id]: value }))}
                  disabled={submitted}
                >
                  {options.map((option, index) => {
                    const label = optionLabel(option)
                    return (
                      <label key={`${question.id}-${index}`} className="flex items-center gap-2.5 text-sm text-foreground">
                        <RadioGroupItem value={label} />
                        {label}
                      </label>
                    )
                  })}
                </RadioGroup>
              ) : question.type === "multiple_choice" ? (
                <div className="flex flex-col gap-2">
                  {options.map((option, index) => {
                    const label = optionLabel(option)
                    const current = (selections[question.id] as string[]) ?? []
                    const checked = current.includes(label)
                    return (
                      <label key={`${question.id}-${index}`} className="flex items-center gap-2.5 text-sm text-foreground">
                        <Checkbox
                          checked={checked}
                          disabled={submitted}
                          onCheckedChange={(next) =>
                            setSelections((prev) => {
                              const existing = (prev[question.id] as string[]) ?? []
                              const updated = next ? [...existing, label] : existing.filter((v) => v !== label)
                              return { ...prev, [question.id]: updated }
                            })
                          }
                        />
                        {label}
                      </label>
                    )
                  })}
                </div>
              ) : (
                <Input
                  value={(selections[question.id] as string) ?? ""}
                  disabled={submitted}
                  placeholder="Type your answer…"
                  onChange={(e) => setSelections((prev) => ({ ...prev, [question.id]: e.target.value }))}
                />
              )}
            </div>
          )
        })}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Button size="sm" className="self-start" disabled={!allAnswered || submitted || submitting} onClick={submit}>
          {submitted ? "Answers sent" : submitting ? "Sending…" : "Submit answers"}
        </Button>
      </CardContent>
    </Card>
  )
}

/** A validated draft, handed over by `present_app` for review — the user installs it themselves from here. */
function AppPreviewCard({ appId }: { appId: string }) {
  const [draft, setDraft] = useState<AppDraft | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    fetchBuildDraft(appId)
      .then(setDraft)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [appId])

  const install = async () => {
    if (installing || installed) return
    setInstalling(true)
    setInstallError(null)
    const result = await installBuildDraft(appId)
    setInstalling(false)
    if (result.ok) {
      setInstalled(true)
      navigate(`/apps/${appId}`)
    } else {
      setInstallError(result.message)
    }
  }

  if (loadError) {
    return (
      <Card className="mt-3">
        <CardContent className="p-4">
          <p className="text-sm text-destructive">Couldn't load the draft: {loadError}</p>
        </CardContent>
      </Card>
    )
  }

  if (!draft) {
    return (
      <Card className="mt-3">
        <CardContent className="p-4">
          <p className="text-sm text-muted-foreground">Loading draft…</p>
        </CardContent>
      </Card>
    )
  }

  const seedRows = draft.data.reduce((total, d) => total + d.count, 0)

  return (
    <Card className="mt-3">
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-3">
          <div
            className="grid size-10 shrink-0 place-items-center rounded-lg text-lg"
            style={{ backgroundColor: draft.app.color ?? "var(--muted)" }}
          >
            {draft.app.emoji ?? "🧩"}
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium leading-tight">{draft.app.name}</p>
            {draft.app.description ? (
              <p className="truncate text-sm leading-tight text-muted-foreground">{draft.app.description}</p>
            ) : null}
          </div>
        </div>

        {draft.entities.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
              {draft.entities.length} {draft.entities.length === 1 ? "entity" : "entities"}
            </p>
            <div className="flex flex-col gap-2">
              {draft.entities.map((entity) => (
                <div key={entity.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="font-medium">{entity.name}</span>
                  {entity.fields.map((field) => (
                    <Badge key={field.id} variant="muted">
                      {field.name}
                    </Badge>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {draft.tools.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
              {draft.tools.length} tool{draft.tools.length === 1 ? "" : "s"}
            </p>
            {draft.tools.map((tool) => (
              <p key={tool.id} className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{tool.name}</span>
                {tool.description ? ` — ${tool.description}` : null}
              </p>
            ))}
          </div>
        ) : null}

        {draft.skills.length > 0 || seedRows > 0 ? (
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
            {[
              draft.skills.length > 0 ? `${draft.skills.length} skill${draft.skills.length === 1 ? "" : "s"}` : null,
              seedRows > 0 ? `${seedRows} seed row${seedRows === 1 ? "" : "s"}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}

        {installError ? <p className="text-sm text-destructive">{installError}</p> : null}

        <Button size="sm" className="self-start" disabled={installing || installed} onClick={install}>
          {installed ? "Installed" : installing ? "Installing…" : "Install app"}
        </Button>
      </CardContent>
    </Card>
  )
}

function BuildPage() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState("")
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

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

    streamBuildChat(
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
      <PageHeader breadcrumb="BUILD · NEW APP" />

      {turns.length === 0 ? (
        <div className="flex-1 overflow-y-auto px-6 py-10 sm:px-10">
          <div className="mx-auto w-full max-w-3xl">
            <Doodle name="spark" className="size-10 text-accent" />
            <Heading level="display" as="h1" className="mt-5">
              Build something for your agent
            </Heading>
            <Muted className="mt-3 max-w-[58ch] text-base leading-relaxed">
              Describe it in your own words. The agent writes the data model, skills, tools and interface, then
              hands you the workspace.
            </Muted>

            <PromptInput
              className="mt-8"
              onSubmit={(event) => {
                event.preventDefault()
                send(draft)
              }}
            >
              <PromptInputTextarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onSubmitMessage={() => send(draft)}
                placeholder="Describe the app you want to create…"
                className="min-h-36"
              />
              <PromptInputToolbar>
                <Button type="submit" className="ml-auto" disabled={!draft.trim() || streaming}>
                  Build app
                </Button>
              </PromptInputToolbar>
            </PromptInput>
          </div>
        </div>
      ) : (
        <>
          <Conversation stickToBottom className="flex-1 px-6 py-6 sm:px-10">
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
                                name={segment.toolName}
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
                                      name={segment.toolName}
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
                        if (segment.kind === "plan") {
                          return <PlanCard key="plan" steps={segment.steps} />
                        }
                        if (segment.kind === "question") {
                          return <QuestionForm key={segment.toolCallId} toolCallId={segment.toolCallId} questions={segment.questions} />
                        }
                        if (segment.kind === "app-preview") {
                          return <AppPreviewCard key={segment.toolCallId} appId={segment.appId} />
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
                              "BUILD AGENT",
                              turn.finishedAt
                                ? new Date(turn.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                                : null,
                              turn.finishedAt ? `${((turn.finishedAt - turn.startedAt) / 1000).toFixed(1)}S` : null,
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
                  placeholder="Reply to the agent…"
                />
                <PromptInputToolbar>
                  <PromptInputSend streaming={streaming} onStop={stop} disabled={!draft.trim()} />
                </PromptInputToolbar>
              </PromptInput>
            </div>
          </div>
        </>
      )}
    </>
  )
}

export { BuildPage }
