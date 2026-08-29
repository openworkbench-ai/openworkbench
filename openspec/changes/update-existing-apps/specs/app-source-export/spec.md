## ADDED Requirements

### Requirement: Export endpoint returns an existing app's current source of truth

The backend SHALL expose a read-only HTTP endpoint that, given the id of an already-registered app, returns that app's **current on-disk manifest** and a gzipped tar of the **active build's stored frontend source**. The manifest returned SHALL be the exact source the runtime is serving, with its `app.id` and every entity/field stable id intact, so that an external client editing it and redeploying produces a stable-id-matched update.

#### Scenario: Known app id with stored source returns manifest and source

- **WHEN** a client requests the export endpoint for a registered app whose active build has stored source
- **THEN** the endpoint responds `200` with the app's current manifest and a gzipped tar of the active build's stored source
- **AND** the returned manifest's `app.id` and stable ids match what the runtime currently serves

#### Scenario: Unknown app id is rejected

- **WHEN** a client requests the export endpoint for an app id that is not registered
- **THEN** the endpoint responds with a non-2xx status and the standard `{"error": {"code", "message"}}` envelope
- **AND** no app state is created or modified

### Requirement: Export signals when no source is on file

When the active build has no stored frontend source (an app deployed before source persistence, or a deploy that shipped none), the export endpoint SHALL still return the current manifest and SHALL clearly signal that no source is available, rather than returning an empty or fabricated source archive. A client receiving this signal can regenerate the frontend from the manifest instead of editing fetched source.

#### Scenario: Sourceless app returns manifest and a no-source signal

- **WHEN** a client requests export for a registered app whose active build has no stored source
- **THEN** the endpoint returns the current manifest and an explicit indication that no frontend source is available
- **AND** does not return a placeholder or empty source tar presented as real source

### Requirement: Export is read-only and side-effect free

The export endpoint SHALL NOT mutate any app's manifest, database, registry entry, stored source, or activated build. Repeated calls for an app not redeployed in between SHALL return equivalent results.

#### Scenario: Export does not alter server state

- **WHEN** a client calls the export endpoint and then a subsequent request hits `/ui/<app_id>/` or the app's `/apps/<app_id>/...` API
- **THEN** the app serves exactly the same activated bundle and operates against exactly the same database as before the export call

#### Scenario: Exported source round-trips through deploy

- **WHEN** the exported manifest and exported source are rebuilt and submitted to `POST /deploy` under a new `jobId`
- **THEN** the deploy is accepted as a redeploy of the same app id and the app's existing data is preserved
