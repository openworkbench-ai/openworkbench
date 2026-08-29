# Agent Bridge Protocol

When the agent is launched with `--bridge-mode`, it switches from interactive
terminal I/O to a newline-delimited JSON (NDJSON) protocol over stdio.

## Stdin → agent

Each line is a JSON object followed by `\n`.

| Type | Fields | Meaning |
|---|---|---|
| `message` | `text: string` | A user refinement turn; agent processes and emits a `turn` response |
| `approve` | — | User approved the plan; agent proceeds to build and submit |

## Agent → stdout

Each line is a JSON object followed by `\n`. The Go bridge reads these lines and
fans them out to SSE subscribers.

| Type | Fields | Meaning |
|---|---|---|
| `turn` | `role: "assistant"`, `text: string` | A new planner assistant message |
| `plan` | `checklist: [{text, done}]` | Emitted when `validate_manifest` succeeds; summarises planned features |
| `ready` | `manifestVersion: number`, `appId?: string` | Emitted when `ready_to_build` is called; means a valid plan exists and the user has approved intent. Waits for `approve` stdin message before building. |
| `error` | `reason: string` | A fatal agent error; the session is dead |
| `done` | `appId?: string` | Clean exit; the deploy has been submitted |

## Lifecycle

```
stdin:   {"type":"message","text":"add a star rating"}
stdout:  {"type":"turn","role":"assistant","text":"Done — added a 1–5 star rating..."}
stdout:  {"type":"plan","checklist":[{"text":"Store and manage Book","done":false}]}
stdout:  {"type":"ready","manifestVersion":1,"appId":"reading_tracker"}
stdin:   {"type":"approve"}
stdout:  {"type":"done","appId":"reading_tracker"}
```

## HTTP endpoints (Go bridge)

| Method | Path | Description |
|---|---|---|
| `POST` | `/platform/plan` | Start a new session; body: `{prompt, appId?}` |
| `GET` | `/platform/plan/{sessionId}/events` | SSE stream; replays buffered events from `Last-Event-ID` |
| `POST` | `/platform/plan/{sessionId}/message` | Send a user refinement; body: `{text}` |
| `POST` | `/platform/plan/{sessionId}/approve` | Approve the plan; returns `{ok, appId}` |

## Session lifecycle

- Sessions live in memory; not persisted across server restarts.
- Timeout: 30 minutes of inactivity (no message, no SSE subscriber).
- Maximum 4 concurrent SSE connections per session.
- A timed-out session emits `{"type":"error","reason":"session_timeout"}` to any active SSE subscribers.
