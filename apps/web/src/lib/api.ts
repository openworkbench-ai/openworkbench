export interface AppInfo {
  id: string
  name: string
  description: string
  emoji?: string
  color?: string
  /** Whether this app can be activated/deactivated — only catalog (engine-backed) apps go through that lifecycle. */
  manageable?: boolean
  status?: "active" | "inactive"
}

export interface ToolParam {
  id: string
  name: string
  type: string
  required?: boolean
}

export interface ToolInfo {
  id: string
  name: string
  description?: string
  params?: ToolParam[]
  /** Set when this tool's result renders via ui/components/<component>.tsx. */
  ui?: { component: string }
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  content: string
}

export interface EntityField {
  id: string
  name: string
  type: string
  required?: boolean
  target?: string
  values?: string[]
}

export interface EntityInfo {
  id: string
  name: string
  fields: EntityField[]
}

export interface DataPage {
  data: Record<string, unknown>[]
  total: number
  limit: number
  offset: number
}

export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelInfo {
  id: string
  name: string
  reasoning?: boolean
  contextWindow?: number
  cost?: ModelCost
}

const BASE = "/api"

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return res.json()
}

export async function fetchApps(): Promise<{ apps: AppInfo[] }> {
  return asJson(await fetch(`${BASE}/apps`))
}

export interface AppStatus {
  id: string
  status: "active" | "inactive"
}

export async function activateApp(id: string): Promise<AppStatus> {
  return asJson(await fetch(`${BASE}/apps/${id}/activate`, { method: "POST" }))
}

export async function deactivateApp(id: string): Promise<AppStatus> {
  return asJson(await fetch(`${BASE}/apps/${id}/deactivate`, { method: "POST" }))
}

export async function fetchAppTools(id: string): Promise<{ tools: ToolInfo[] }> {
  return asJson(await fetch(`${BASE}/apps/${id}/tools`))
}

export async function fetchAppSkills(id: string): Promise<{ skills: SkillInfo[] }> {
  return asJson(await fetch(`${BASE}/apps/${id}/skills`))
}

export async function fetchAppEntities(id: string): Promise<{ entities: EntityInfo[] }> {
  return asJson(await fetch(`${BASE}/apps/${id}/entities`))
}

export async function fetchAppData(
  id: string,
  entity: string,
  params: { limit?: number; offset?: number; sort?: string } = {},
): Promise<DataPage> {
  const query = new URLSearchParams()
  if (params.limit != null) query.set("limit", String(params.limit))
  if (params.offset != null) query.set("offset", String(params.offset))
  if (params.sort) query.set("sort", params.sort)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return asJson(await fetch(`${BASE}/apps/${id}/data/${entity}${suffix}`))
}

/** Fetches one app's MCP Apps `ui://` resource (a built component's HTML) through
 * the runtime's proxy — the browser never reaches the engine's MCP endpoint directly. */
export async function fetchAppMcpResource(id: string, uri: string): Promise<{ contents?: { text?: string }[] }> {
  return asJson(await fetch(`${BASE}/apps/${id}/mcp-resource?uri=${encodeURIComponent(uri)}`))
}

/** Calls a tool on one app's MCP server, proxied the same way — used when a
 * rendered component (McpAppFrame) calls back into a tool. */
export async function callAppMcpTool(id: string, tool: string, args: Record<string, unknown> | undefined): Promise<unknown> {
  return asJson(
    await fetch(`${BASE}/apps/${id}/mcp-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
    }),
  )
}

export async function fetchModels(): Promise<{ models: ModelInfo[]; current: string }> {
  return asJson(await fetch(`${BASE}/models`))
}

export async function switchModel(modelId: string): Promise<{ current: string }> {
  return asJson(
    await fetch(`${BASE}/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId }),
    }),
  )
}

export type AgentStreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_end"
      toolCallId: string
      toolName: string
      result: unknown
      isError: boolean
      resourceUri?: string
      appId?: string
    }
  | { type: "done" }
  | { type: "error"; reason: string }

/** Shared streaming plumbing for both `/chat` and `/build-chat` — same SSE event shape. */
async function streamSse(
  path: string,
  message: string,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Chat request failed (${res.status})`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf("\n\n")
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const line = chunk.split("\n").find((l) => l.startsWith("data: "))
      if (line) onEvent(JSON.parse(line.slice(6)))
      boundary = buffer.indexOf("\n\n")
    }
  }
}

/** POSTs a chat message and parses the SSE response as it streams in. */
export async function streamChat(
  message: string,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSse("/chat", message, onEvent, signal)
}

/** Same as {@link streamChat}, against the build agent's own session. */
export async function streamBuildChat(
  message: string,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSse("/build-chat", message, onEvent, signal)
}

export interface AskQuestion {
  id: string
  question: string
  type: "single_choice" | "multiple_choice" | "free_text"
  options?: string[]
}

export interface PlanStep {
  id: string
  label: string
  status: "pending" | "active" | "done" | "failed"
}

/** Answers a pending `ask_questions` tool call so the build agent's turn can resume. */
export async function answerBuildQuestions(
  toolCallId: string,
  answers: { id: string; answer: string | string[] }[],
): Promise<void> {
  await asJson(
    await fetch(`${BASE}/build-chat/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolCallId, answers }),
    }),
  )
}

/** Same as {@link fetchModels}/{@link switchModel}, against the build agent's own session. */
export async function fetchBuildModels(): Promise<{ models: ModelInfo[]; current: string }> {
  return asJson(await fetch(`${BASE}/build-chat/models`))
}

export async function switchBuildModel(modelId: string): Promise<{ current: string }> {
  return asJson(
    await fetch(`${BASE}/build-chat/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId }),
    }),
  )
}

/** A build agent's in-progress draft — read straight off its scratch workspace for the review card. */
export interface AppDraft {
  id: string
  app: { id: string; name: string; description?: string; emoji?: string; color?: string; version?: number }
  entities: EntityInfo[]
  tools: ToolInfo[]
  skills: string[]
  data: { entity: string; count: number }[]
  ui: string[]
}

/** Fetches the draft `present_app` handed to the user for review, by app id. */
export async function fetchBuildDraft(id: string): Promise<AppDraft> {
  return asJson(await fetch(`${BASE}/build-chat/draft/${id}`))
}

export type InstallResult = { ok: true; message: string } | { ok: false; status: number; message: string }

/**
 * Saves and installs a drafted app — the user-initiated action behind the review card's "Install" button. Resolves
 * with `{ ok: false, ... }` rather than throwing on rejection, since a validation/install failure here is an
 * expected outcome the card should display, not an exceptional one.
 */
export async function installBuildDraft(id: string): Promise<InstallResult> {
  const res = await fetch(`${BASE}/build-chat/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  })
  return res.json()
}
