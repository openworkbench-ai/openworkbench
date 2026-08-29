## ADDED Requirements

### Requirement: Bridge mode flag support
The agent CLI (`agent/src/cli.ts`) SHALL accept a `--bridge-mode` flag in addition to all existing flags. When `--bridge-mode` is present, the agent runs the planning loop as defined in `shell-agent-bridge/spec.md` — reading user messages from stdin as JSON lines and writing turn/plan/ready/error/done events to stdout as JSON lines. All other behaviors (manifest validation, builder session, deploy submission) are unchanged.

#### Scenario: Bridge mode does not affect existing CLI usage
- **WHEN** the agent is invoked without `--bridge-mode` (the existing CLI path)
- **THEN** the agent behaves identically to before this change: interactive readline input, human-readable prose output

#### Scenario: Bridge mode input/output format
- **WHEN** the agent is invoked with `--bridge-mode`
- **THEN** stdout contains only newline-delimited JSON event objects and stdin is consumed as newline-delimited JSON message objects

## MODIFIED Requirements

### Requirement: Consumer of deploy HTTP seam
The `POST /deploy` endpoint remains unchanged in protocol. The set of valid callers now includes the shell frontend (via the agent bridge's approve flow) in addition to the existing CLI path. No changes to request shape, response shape, authentication (none), or idempotency semantics.

#### Scenario: Browser-initiated deploy via bridge
- **WHEN** the user approves a plan in the shell's plan-review screen
- **THEN** the agent bridge writes `{"type":"approve"}` to the agent subprocess stdin, the agent calls `POST /deploy` as it normally would from the CLI path, and the same multipart payload format and idempotency behavior apply

#### Scenario: CLI deploy still works
- **WHEN** the CLI agent is run without `--bridge-mode` and the user types "build it"
- **THEN** the agent calls `POST /deploy` as before; no change in behavior
