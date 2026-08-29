## MODIFIED Requirements

### Requirement: App metadata stored in platform.db

The system SHALL maintain an `app_meta` table in `platform.db` with one row per known app
id, storing `emoji` (text, single Unicode grapheme cluster), `color` (text, hex color string
e.g. `#A8D5A2`), `display_name` (text, human label overriding the manifest `name`), and
`grid_order` (integer, ascending sort position in the launcher grid). Rows are upserted
automatically when an app is registered or discovered. Defaults: emoji `📦`, color
`#E0E0E0`, display_name copied from the manifest `name`, grid_order assigned as
`MAX(grid_order)+1` at upsert time.

For a brand-new app's first install, the `app_meta` row SHALL be upserted as soon as that
app's build job transitions to `building` — not deferred until the build (materialize,
frontend compile, activation) finishes or fails. This guarantees `GET /platform/registry`
can report a live `buildState` for the app from the start of its first build.

#### Scenario: First boot with existing apps

- **WHEN** the server starts with one or more apps already registered in the registry
- **THEN** each app that has no `app_meta` row gets one inserted with default values before
  any request is served

#### Scenario: New app deployed

- **WHEN** a new app is deployed via `POST /deploy` and the registry registers it
- **THEN** an `app_meta` row is upserted for the new app id with default values

#### Scenario: New app build starts

- **WHEN** a brand-new (not-yet-registered) app id's first build job transitions to
  `building` inside `build.Bootstrap`
- **THEN** an `app_meta` row for that app id exists immediately, seeded from the manifest's
  `name`/`emoji`/`color` (or the documented defaults), before materialization, frontend
  build, or registry activation have completed

#### Scenario: First install fails

- **WHEN** a brand-new app's first build fails after its job reached `building`
- **THEN** the `app_meta` row created for it persists, so `GET /platform/registry` continues
  to report that app id with `buildState: "failed"` instead of the app disappearing entirely
