## ADDED Requirements

### Requirement: Deploy ingest accepts an optional frontend source part

`POST /deploy` SHALL accept an additional, **optional** `source` multipart part carrying a gzipped tar of the deploy's editable frontend source. When present, the endpoint SHALL extract it under the same path-traversal, symlink, and size/entry-count guards used for the `bundle` part, and route it to the frontend-source store keyed on the request's `jobId`. When the `source` part is absent, the endpoint SHALL behave exactly as it does without this change — no source is stored and the deploy still succeeds.

#### Scenario: Source part is stored alongside the bundle

- **WHEN** a well-formed deploy request includes both a `bundle` part and a `source` part
- **THEN** the served bundle is activated as before and the source is persisted under the deploy's job id
- **AND** the response is unchanged from a deploy that carried no source

#### Scenario: Missing source part is allowed

- **WHEN** a deploy request omits the `source` part
- **THEN** the endpoint completes the deploy as before and stores no source artifact

#### Scenario: Source part is contained like the bundle

- **WHEN** the `source` part contains an entry that escapes the target directory via `..`, an absolute path, or a symlink
- **THEN** the endpoint aborts the deploy with the error envelope and writes no file outside the app's directory
