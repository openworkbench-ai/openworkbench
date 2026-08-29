# stable-id-storage Specification

## Purpose

Physical storage identifiers derive from immutable stable ids rather than mutable display
names, so that renames are free and the storage layer is decoupled from presentation.

## Requirements

### Requirement: Physical identifiers derive from stable id

The system SHALL name every physical SQLite table, column, unique index, and foreign-key
target after the schema element's immutable stable `id`, never its mutable display `name`.
The materializer and the store SHALL use stable `id` for all generated identifiers.
Platform-managed columns (`id`, `created_at`, `updated_at`) SHALL keep their fixed names.

#### Scenario: Table and column names come from id

- **WHEN** an entity with id `ent_task` containing a field with id `fld_task_title` and name
  `title` is materialized
- **THEN** the generated DDL creates a table named `ent_task` with a column named
  `fld_task_title`, and no identifier in the DDL is derived from a display name

#### Scenario: Foreign keys reference the target's id

- **WHEN** a reference field targets entity id `ent_project`
- **THEN** the foreign-key clause references table `ent_project(id)`

### Requirement: Renames produce no SQL

The system SHALL treat a change that alters only an entity's or field's display `name` (with
the stable `id` unchanged) as a manifest/registry update that emits no DDL and no DML.

#### Scenario: Renaming a field changes no physical column

- **WHEN** a field's `name` changes from `deadline` to `due_date` while its `id` is unchanged
- **THEN** the migration applies with zero SQL statements executed, and all existing row data
  is preserved unchanged

### Requirement: Stable ids are validated as SQL-safe identifiers

The system SHALL reject any manifest whose app, entity, or field `id` is not a SQL-safe
identifier matching `^[a-z][a-z0-9_]*$`. Validation SHALL be a hard gate: a manifest with an
unsafe id is never materialized or served.

#### Scenario: Unsafe id is rejected

- **WHEN** a manifest declares an entity with id `Task; DROP TABLE` or `ent-task`
- **THEN** validation fails with a structured error and the manifest is not served

#### Scenario: Safe id is accepted

- **WHEN** a manifest declares ids `project_hub`, `ent_task`, and `fld_task_title`
- **THEN** validation passes

### Requirement: The API resolves names to ids at its boundary

The system SHALL translate request field names to stable ids before reaching the store, and
translate stored id-keyed columns back to display names in responses, so the HTTP CRUD/query
surface remains name-based and behaviourally unchanged from Phase 1.

#### Scenario: Request and response use display names

- **WHEN** a client creates or queries a row using display field names
- **THEN** the request succeeds against id-keyed physical columns and the response is keyed by
  display names, identical to Phase 1 behaviour
