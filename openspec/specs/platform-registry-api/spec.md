# platform-registry-api Specification

## Purpose

Maintain app display metadata in `platform.db` and expose HTTP endpoints for reading the
live registry (with build status), updating per-app display attributes (emoji, color,
display name), and reordering the launcher grid.

## Requirements

### Requirement: App metadata stored in platform.db

The system SHALL maintain an `app_meta` table in `platform.db` with one row per known app
id, storing `emoji` (text, single Unicode grapheme cluster), `color` (text, hex color string
e.g. `#A8D5A2`), `display_name` (text, human label overriding the manifest `name`), and
`grid_order` (integer, ascending sort position in the launcher grid). Rows are upserted
automatically when an app is registered or discovered. Defaults: emoji `📦`, color
`#E0E0E0`, display_name copied from the manifest `name`, grid_order assigned as
`MAX(grid_order)+1` at upsert time.

#### Scenario: First boot with existing apps

- **WHEN** the server starts with one or more apps already registered in the registry
- **THEN** each app that has no `app_meta` row gets one inserted with default values before
  any request is served

#### Scenario: New app deployed

- **WHEN** a new app is deployed via `POST /deploy` and the registry registers it
- **THEN** an `app_meta` row is upserted for the new app id with default values

### Requirement: List registry with live build status

The system SHALL serve `GET /platform/registry` returning a JSON array of registry entries,
each containing: `appId` (string), `emoji` (string), `color` (string), `displayName`
(string), `gridOrder` (integer), `buildState` (string — one of
`ready|building|activating|queued|failed|none`), `manifestVersion` (integer or null), and
`activeBuildId` (string or null). The array is sorted ascending by `gridOrder`.

#### Scenario: Happy path

- **WHEN** a GET request is made to `/platform/registry`
- **THEN** the response is HTTP 200 with `Content-Type: application/json` and a JSON array
  of all registered apps

#### Scenario: Empty registry

- **WHEN** no apps are registered
- **THEN** the response is HTTP 200 with an empty JSON array `[]`

#### Scenario: Build state accuracy

- **WHEN** an app has an active build job in state `building`
- **THEN** that app's `buildState` field in the registry response is `"building"` and
  `activeBuildId` is the job's ID

#### Scenario: No active build

- **WHEN** an app has no build job on record
- **THEN** that app's `buildState` is `"none"` and `activeBuildId` is null

### Requirement: Update app display metadata

The system SHALL accept `PATCH /platform/registry/{appId}` with a JSON body containing any
subset of `emoji`, `color`, `displayName`, `gridOrder`. Only provided fields are updated;
omitted fields are unchanged. The response is HTTP 200 with the full updated registry entry.

#### Scenario: Update emoji and color

- **WHEN** a PATCH request is sent with `{"emoji":"🌱","color":"#A8D5A2"}`
- **THEN** the row is updated, the response contains the new values, and a subsequent GET
  reflects the changes

#### Scenario: Unknown appId

- **WHEN** a PATCH request targets an appId not in the registry
- **THEN** the response is HTTP 404 with a JSON error body `{"error":"app not found"}`

#### Scenario: Invalid emoji (multi-codepoint)

- **WHEN** a PATCH request sets `emoji` to a string that exceeds one Unicode grapheme
  cluster
- **THEN** the response is HTTP 400 with a JSON error body describing the constraint

### Requirement: Reorder grid

The system SHALL accept `POST /platform/registry/reorder` with a JSON body
`{"order":["appId1","appId2",...]}` and reassign `grid_order` values such that the array
index becomes the new sort order (0-based). All provided app ids MUST be known; extra ids
are rejected; missing ids are left at the end with grid_order values after the provided ids.

#### Scenario: Full reorder

- **WHEN** a reorder request is sent with all known app ids in a new order
- **THEN** each app's `grid_order` is updated and a subsequent GET reflects the new order

#### Scenario: Unknown id in list

- **WHEN** a reorder request includes an unknown app id
- **THEN** the response is HTTP 400 with a JSON error identifying the unknown id
