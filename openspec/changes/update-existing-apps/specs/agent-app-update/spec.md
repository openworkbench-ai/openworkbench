## ADDED Requirements

### Requirement: Agent CLI targets an existing app for update

The agent CLI SHALL accept an optional way to name an existing app id to update (e.g. an `--app <app_id>` flag). When an app id is provided, the orchestrator SHALL fetch that app's current manifest and frontend source through the app-source read seam and seed both the planning and build sessions from that fetched source. When no app id is provided, the agent SHALL behave exactly as today, authoring a brand-new app from a blank slate with no fetch call.

#### Scenario: Update mode seeds from the fetched app

- **WHEN** the CLI is invoked with an existing app id and a change request
- **THEN** the orchestrator fetches that app's current manifest (and source, if any) over the read seam before planning begins
- **AND** the planner's starting manifest is the fetched manifest, not an empty draft

#### Scenario: No app id is unchanged new-app flow

- **WHEN** the CLI is invoked without an app id
- **THEN** the agent authors a brand-new app exactly as it does today, making no fetch call

#### Scenario: Unknown app id fails fast

- **WHEN** the CLI is invoked with an app id the backend does not recognize
- **THEN** the agent reports the error and does not start a planning session against an empty or fabricated manifest

### Requirement: Update preserves app id and stable ids

When updating an existing app, the planner SHALL preserve the fetched manifest's `app.id` and every entity and field **stable id** through all edits, only changing names, adding new entities/fields (with new stable ids), or removing them. The agent SHALL NOT mint a new `app.id` for an update, and SHALL NOT regenerate stable ids for entities/fields that are renamed or kept. A submit-time guard SHALL assert that the outgoing `app.id` equals the fetched id before the irreversible deploy.

#### Scenario: Renamed field keeps its stable id

- **WHEN** the user asks to rename an existing field during an update
- **THEN** the resulting manifest carries the same stable id for that field with the new name
- **AND** the redeploy is diffed as a data-preserving rename, not a drop-and-add

#### Scenario: App id is never reminted on update

- **WHEN** an update is built and submitted
- **THEN** the submitted manifest's `app.id` equals the fetched app's id
- **AND** the backend routes the submission to its redeploy (update) path, not first-install

### Requirement: Builder edits fetched source, or regenerates when none exists

When updating an app whose export returned frontend source, the builder session SHALL be seeded with that fetched source plus the regenerated typed client, and SHALL edit those files rather than authoring a fresh frontend. When export signals that no source is available, the agent SHALL regenerate the frontend from the manifest as in the new-app flow. In both cases the submitter SHALL ship the resulting editable source (the `src/` scaffold, excluding `node_modules`/`dist`) as the deploy's `source` part, and the existing scratch-directory guard SHALL continue to confine all writes to the job's scratch directory.

#### Scenario: Frontend update starts from the deployed source

- **WHEN** the builder runs in update mode and the export returned source
- **THEN** the scratch directory is pre-populated with the fetched source plus the regenerated client
- **AND** the builder modifies those files rather than recreating the UI from scratch

#### Scenario: Sourceless app regenerates the frontend

- **WHEN** the builder runs in update mode and the export signaled no source available
- **THEN** the agent regenerates the frontend from the manifest
- **AND** the redeploy still preserves the app's data via the unchanged stable-id manifest

#### Scenario: Edited source is persisted on redeploy

- **WHEN** an update is submitted
- **THEN** the submitter includes a `source` part carrying the edited `src/` scaffold
- **AND** that source becomes the active build's stored source after the redeploy

### Requirement: App-source fetch is a selectable seam

The agent's app-source fetcher SHALL be an interface selected the same way the submitter is (via environment in `seams/select.ts`), with an HTTP implementation that reads from the backend export endpoint at the configured base URL, and SHALL default so that existing local/stub flows are unchanged and make no network call.

#### Scenario: HTTP fetch mode reads from the backend

- **WHEN** the agent runs in update mode against a live backend
- **THEN** the fetcher retrieves the app's manifest and source from the backend export endpoint at the configured base URL

#### Scenario: Default mode does not require a backend

- **WHEN** the agent runs in its default (non-HTTP) mode
- **THEN** no network fetch is made and existing local flows behave exactly as before
