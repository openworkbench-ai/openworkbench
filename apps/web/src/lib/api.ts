export interface AppInfo {
  id: string
  name: string
  description: string
  emoji?: string
  color?: string
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
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: "done" }
  | { type: "error"; reason: string }

/** POSTs a chat message and parses the SSE response as it streams in. */
export async function streamChat(
  message: string,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}/chat`, {
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
