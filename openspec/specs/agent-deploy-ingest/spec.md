## ADDED Requirements

### Requirement: Deploy ingest endpoint accepts an approved bundle

The backend SHALL expose `POST /deploy` accepting a `multipart/form-data` request carrying a `jobId` field, a `manifest` part (manifest JSON), and a `bundle` part (a gzipped tar of the built frontend `dist/` tree). The endpoint SHALL validate the manifest with the same hard gate used at boot before writing anything to disk, and SHALL reject a request whose manifest fails validation without creating or modifying any app.

#### Scenario: Valid bundle is accepted

- **WHEN** a client POSTs a well-formed multipart request whose `manifest` part passes validation and whose `bundle` part contains the manifest's entry file
- **THEN** the endpoint installs the app and responds `200` with a JSON body containing `appId`, `version`, `jobId`, and the reachable `url` `/ui/<app_id>/`

#### Scenario: Invalid manifest is rejected with the error envelope

- **WHEN** the `manifest` part fails structural or semantic validation
- **THEN** the endpoint responds with a non-2xx status and the standard `{"error": {"code", "message"}}` envelope
- **AND** no `apps/<app_id>/` directory is created or modified and no app is registered

#### Scenario: Malformed request is rejected

- **WHEN** the request is missing the `jobId`, `manifest`, or `bundle` part
- **THEN** the endpoint responds with a client-error status and the error envelope, and makes no change to server state

### Requirement: First install registers a brand-new app live

When the manifest's app id is not already registered, the endpoint SHALL create `apps/<app_id>/` with the manifest and the extracted bundle, open the app's database, materialize its schema DDL, register the app in the live registry, and build and activate its frontend — without requiring a server restart.

#### Scenario: New app becomes reachable immediately

- **WHEN** a bundle for a previously unknown app id is deployed successfully
- **THEN** a subsequent request to `/ui/<app_id>/` serves the app's entry file
- **AND** a subsequent request to that app's `/apps/<app_id>/...` API operates against a freshly materialized database

#### Scenario: First install failure leaves no partial app

- **WHEN** opening the store, materializing DDL, or activating the frontend fails during a first install
- **THEN** the endpoint responds with the error envelope
- **AND** no app with that id is left registered and no partially written `apps/<app_id>/` directory remains served

### Requirement: Known app id redeploys through the build pipeline

When the manifest's app id is already registered, the endpoint SHALL write the new bundle and route the deploy through the existing build/activation pipeline, which decides between a frontend-only reinstall and a data-migration redeploy by manifest version and preserves its single rollback contract.

#### Scenario: Redeploy activates the new bundle

- **WHEN** a bundle for an already-registered app id at the same manifest version is deployed
- **THEN** the new frontend bundle becomes the activated build served at `/ui/<app_id>/`
- **AND** the app's existing data is preserved

#### Scenario: Redeploy failure rolls back to the prior version

- **WHEN** a redeploy fails during migration or activation
- **THEN** the app remains exactly as reachable as it was before the request, serving its prior activated bundle and prior data

### Requirement: Deploy is idempotent on job id

The endpoint SHALL be idempotent with respect to `jobId`: a repeated POST for a job that already completed successfully SHALL return that job's result without performing a second deploy, and a retry of a failed job SHALL be able to converge to a successful deploy.

#### Scenario: Retry of a completed job is a no-op deploy

- **WHEN** a client re-POSTs a bundle whose `jobId` already produced a ready, activated build
- **THEN** the endpoint returns the same `appId`, `version`, and `url` without creating a duplicate app or a second activated build

### Requirement: Bundle extraction is contained

The endpoint SHALL extract the bundle tar only into the target app's directory, rejecting any archive entry that escapes it via `..`, an absolute path, or a symlink, and SHALL enforce limits on total extracted size and entry count so an untrusted bundle cannot exhaust disk.

#### Scenario: Path-traversal entry is rejected

- **WHEN** the bundle tar contains an entry whose path resolves outside the target app directory
- **THEN** the endpoint aborts the deploy with the error envelope and writes no file outside the app directory

### Requirement: Agent submits over HTTP through the existing seam

The agent's `HttpSubmitter` SHALL implement the `Submitter` interface by POSTing the manifest and a gzipped tar of the scratch build's `dist/` to the backend `/deploy` endpoint at `GO_BASE_URL`, keyed on the orchestrator `jobId`, and SHALL return the deployed `appId`. Selection SHALL remain controlled solely by `SUBMIT_MODE` in `seams/select.ts`, with `stub` as the default so existing local flows are unchanged.

#### Scenario: SUBMIT_MODE=http submits to the backend

- **WHEN** `SUBMIT_MODE=http` and the orchestrator calls `submit()` after a successful build
- **THEN** the agent POSTs the manifest and the built bundle to `GO_BASE_URL/deploy` and returns the `appId` reported by the backend

#### Scenario: Default mode is unchanged

- **WHEN** `SUBMIT_MODE` is unset
- **THEN** the agent uses `StubSubmitter` and writes to `agent/out/<jobId>/` exactly as before, making no network call

### Requirement: Bridge mode flag support

The agent CLI (`agent/src/cli.ts`) SHALL accept a `--bridge-mode` flag in addition to all
existing flags. When `--bridge-mode` is present, the agent runs the planning loop as
defined in `shell-agent-bridge/spec.md` — reading user messages from stdin as JSON lines
and writing turn/plan/ready/error/done events to stdout as JSON lines. All other behaviors
(manifest validation, builder session, deploy submission) are unchanged.

#### Scenario: Bridge mode does not affect existing CLI usage

- **WHEN** the agent is invoked without `--bridge-mode` (the existing CLI path)
- **THEN** the agent behaves identically to before this change: interactive readline input,
  human-readable prose output

#### Scenario: Bridge mode input/output format

- **WHEN** the agent is invoked with `--bridge-mode`
- **THEN** stdout contains only newline-delimited JSON event objects and stdin is consumed
  as newline-delimited JSON message objects

### Requirement: Consumer of deploy HTTP seam (extended)

The `POST /deploy` endpoint remains unchanged in protocol. The set of valid callers now
includes the shell frontend (via the agent bridge's approve flow) in addition to the
existing CLI path. No changes to request shape, response shape, authentication (none), or
idempotency semantics.

#### Scenario: Browser-initiated deploy via bridge

- **WHEN** the user approves a plan in the shell's plan-review screen
- **THEN** the agent bridge writes `{"type":"approve"}` to the agent subprocess stdin, the
  agent calls `POST /deploy` as it normally would from the CLI path, and the same multipart
  payload format and idempotency behavior apply

#### Scenario: CLI deploy still works

- **WHEN** the CLI agent is run without `--bridge-mode` and the user types "build it"
- **THEN** the agent calls `POST /deploy` as before; no change in behavior
