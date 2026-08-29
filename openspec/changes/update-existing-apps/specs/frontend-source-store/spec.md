## ADDED Requirements

### Requirement: Frontend source is persisted as a job-versioned artifact

When a deploy supplies frontend source, the backend SHALL store it as an immutable artifact keyed by the deploy's job id, sibling to the served build artifact (e.g. `apps/<app_id>/sources/<jobID>/`), and SHALL NOT overwrite a previous job's source in place. The stored source SHALL be the editable scaffold (frontend `src/` and build config) — never `node_modules` or the built `dist/`.

#### Scenario: Source-bearing deploy stores source under the job id

- **WHEN** a deploy for job `J` includes a frontend source archive
- **THEN** the backend writes the extracted source under that app's `sources/<J>/` artifact directory
- **AND** a previous job's stored source remains untouched

#### Scenario: Deploy without source stores nothing extra

- **WHEN** a deploy includes no frontend source archive
- **THEN** the deploy still completes and no source artifact is created for that job

### Requirement: Stored source shares the build's activation and pruning lifecycle

The stored source SHALL be pinned by the same activation pointer that selects the live build: the "current" source for an app SHALL be the source stored under the currently active build's job id. A rollback that repoints activation to a prior build SHALL thereby make that prior build's stored source current. Stored source SHALL be pruned on the same tail-retention as build artifacts, so retiring an old build also retires its source.

#### Scenario: Rollback repoints source with the build

- **WHEN** activation is rolled back from build `J2` to a prior build `J1`
- **THEN** the app's current source becomes the source stored under `J1`
- **AND** the current source never refers to a build that is not the active one

#### Scenario: Pruning retires source with its build

- **WHEN** an old build artifact is pruned beyond the retained tail
- **THEN** that build's stored source is removed as well

### Requirement: Stored source is opaque and never executed

The backend SHALL treat stored frontend source as opaque bytes: it SHALL NOT install dependencies, run a build, or otherwise execute the source. Extraction of the source archive SHALL be contained by the same path-traversal, symlink, and size/entry-count guards applied to the build bundle.

#### Scenario: Source is stored without being built

- **WHEN** frontend source is ingested
- **THEN** the backend stores it without running any package install or build step

#### Scenario: Malicious source archive is contained

- **WHEN** a source archive contains an entry that escapes the target directory via `..`, an absolute path, or a symlink
- **THEN** extraction is aborted with the error envelope and no file is written outside the app's source artifact directory
