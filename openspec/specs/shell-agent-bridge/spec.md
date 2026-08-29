# shell-agent-bridge Specification

## Purpose

Manage agent planning sessions server-side: spawn agent subprocesses in bridge mode,
forward their stdout JSON lines as SSE events, route user messages to subprocess stdin, and
coordinate build approval so the browser can drive the full plan → build flow over HTTP.

## Requirements

### Requirement: Planning session lifecycle

The system SHALL manage agent planning sessions via a `platform/plan` Go package. A session
is identified by a UUID `sessionId`, has a lifecycle (active / completed / failed /
timed-out), and maps to one agent subprocess. Sessions are kept in memory; they are not
persisted to `platform.db`. A session times out after 30 minutes of inactivity (no message
received, no SSE subscriber); the subprocess is killed and the session entry is removed.

#### Scenario: Session created

- **WHEN** `POST /platform/plan` is called with a valid auth session and a non-empty
  `{"prompt":"..."}` body
- **THEN** a new sessionId is generated, an agent subprocess is spawned in `--bridge-mode`,
  and the response is HTTP 201 `{"sessionId":"<uuid>","state":"active"}`

#### Scenario: Session for existing app (update mode)

- **WHEN** `POST /platform/plan` is called with `{"prompt":"...","appId":"reading_tracker"}`
- **THEN** the agent subprocess is spawned with the `--app reading_tracker` flag so it loads
  the existing manifest and enters update mode

#### Scenario: Session timeout

- **WHEN** 30 minutes pass with no message posted and no SSE subscriber connected
- **THEN** the subprocess is killed, the session transitions to `timed-out`, and any
  reconnecting SSE clients receive a final `{"type":"error","reason":"session_timeout"}`
  event

### Requirement: Bridge mode flag in agent

The Node agent (`agent/src/cli.ts`) SHALL accept a `--bridge-mode` flag. When present,
output to stdout changes from human-readable prose to newline-delimited JSON events. Each
event is a JSON object on a single line followed by `\n`. The event types are:

- `{"type":"turn","role":"assistant","text":"<message>"}` — a new agent planning turn.
- `{"type":"plan","checklist":[{"text":"<item>","done":false},...]}` — a plan state update
  from `validate_manifest` success.
- `{"type":"ready","manifestVersion":<n>}` — the agent has called `ready_to_build` and the
  build should proceed.
- `{"type":"error","reason":"<message>"}` — a fatal agent error.
- `{"type":"done"}` — the session ended normally.

Stdin in bridge mode receives lines of the form `{"type":"message","text":"<user input>"}`.
User message delivery is acknowledged by the next `turn` event on stdout.

#### Scenario: Normal planning turn

- **WHEN** the agent generates a new assistant message
- **THEN** a `{"type":"turn","role":"assistant","text":"..."}` line is emitted to stdout

#### Scenario: Plan validated

- **WHEN** `validate_manifest` succeeds
- **THEN** a `{"type":"plan","checklist":[...]}` line is emitted summarising the planned
  features

#### Scenario: Ready to build signalled

- **WHEN** the agent calls `ready_to_build`
- **THEN** a `{"type":"ready","manifestVersion":<n>}` line is emitted

#### Scenario: User message received

- **WHEN** a `{"type":"message","text":"Can you add star ratings?"}` line is written to
  stdin
- **THEN** the agent processes it as the next user turn in the planning loop

### Requirement: SSE event stream

The system SHALL serve `GET /platform/plan/{sessionId}/events` as a Server-Sent Events
stream (`Content-Type: text/event-stream`). Each bridge-mode JSON line emitted by the agent
subprocess is forwarded as an SSE `data:` event. The stream stays open until the session
ends; on end a final SSE event `data: {"type":"done"}` is sent and the connection is closed.
At most 4 concurrent SSE subscribers are allowed per session; a 5th connection receives
HTTP 429.

#### Scenario: Event forwarded

- **WHEN** the agent subprocess emits a `{"type":"turn",...}` line
- **THEN** within 200 ms the SSE stream sends `data: {"type":"turn",...}\n\n` to all
  connected subscribers

#### Scenario: Reconnect after drop

- **WHEN** an SSE client reconnects with `Last-Event-ID` header
- **THEN** any buffered events since that ID are replayed (buffer holds the last 50 events
  per session)

#### Scenario: Session not found

- **WHEN** `GET /platform/plan/{sessionId}/events` is called with an unknown sessionId
- **THEN** the response is HTTP 404

### Requirement: Send user message

The system SHALL serve `POST /platform/plan/{sessionId}/message` accepting `{"text":"..."}`
JSON. The text is written as a bridge-mode message line to the agent subprocess stdin. The
response is HTTP 202 `{"ok":true}` if the session is active, or HTTP 409
`{"error":"session not active"}` if the session has completed or timed out.

#### Scenario: Message delivered

- **WHEN** a POST with `{"text":"add a due date field"}` is sent to an active session
- **THEN** the line `{"type":"message","text":"add a due date field"}` is written to the
  subprocess stdin and the response is HTTP 202

#### Scenario: Message to completed session

- **WHEN** a POST is sent to a session whose subprocess has exited with `{"type":"done"}`
- **THEN** the response is HTTP 409

### Requirement: Build approval via agent bridge

The system SHALL serve `POST /platform/plan/{sessionId}/approve`. This endpoint is only
valid when the session has emitted a `ready` event. On call it writes `{"type":"approve"}`
to the subprocess stdin, causing the agent to proceed with its existing `ready_to_build`
flow and call `POST /deploy`. The response is HTTP 202 `{"ok":true,"appId":"<id>"}`. The
shell uses the returned `appId` to navigate to the home screen and begin polling build
status.

#### Scenario: Approve ready session

- **WHEN** a session has emitted a `{"type":"ready"}` event and
  `POST /platform/plan/{sessionId}/approve` is called
- **THEN** the agent proceeds to deploy, the response is HTTP 202, and within a short time a
  new app appears in `GET /platform/registry` with `buildState` `queued` or `building`

#### Scenario: Approve non-ready session

- **WHEN** `POST /platform/plan/{sessionId}/approve` is called before the session has
  emitted `ready`
- **THEN** the response is HTTP 409 `{"error":"not ready"}`
