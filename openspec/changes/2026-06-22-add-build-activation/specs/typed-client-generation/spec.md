# typed-client-generation Specification

## Purpose

Generate a typed TypeScript client from a validated manifest's schema model, so a
hand-authored frontend can call the generic API with full type safety and zero
hand-maintained duplication of its contract.

## Requirements

### Requirement: Generation is a pure, deterministic function of the schema model

The system SHALL generate TypeScript output purely from a validated `*schema.App`; it
SHALL NOT read or write Go structs or hand-maintained TypeScript interfaces. For an
unchanged schema, generation SHALL produce byte-identical output on every run.

#### Scenario: Unchanged manifest regenerates byte-identically

- **WHEN** Generate is called twice with the same validated schema
- **THEN** the two outputs are byte-for-byte identical

### Requirement: Generated types and methods match the live API contract exactly

For every entity, the system SHALL emit a row type (platform columns plus every declared
field in manifest order), a Create input type and an Update input type gated by which
operations the entity allows, and a filterable/sortable field union covering every declared
field plus the three platform columns. The system SHALL emit a client class per entity
exposing exactly the CRUD and list methods the entity's manifest enables, using the same URL
scheme (`/apps/{app}/{entity}[/{id}]`), the same query syntax (`filter=field:op:value`,
`sort`, `limit`, `offset`), the same JSON request/response shapes, and the same error
envelope as the generic HTTP API.

#### Scenario: Disabled operations are omitted

- **WHEN** an entity's manifest restricts its operations (e.g. to create and read only)
- **THEN** the generated client class omits the update and delete methods and their input
  types entirely

#### Scenario: A required field with a default is optional on create

- **WHEN** a field is required but has a manifest-declared default
- **THEN** its Create input type marks the field optional, while its row type keeps it
  non-nullable

#### Scenario: A reference field's create input accepts the target's id

- **WHEN** an entity has a reference field
- **THEN** the generated Create/Update input types type that field as the target id
  (string), and an absent or removed reference is reflected as nullable in the row type
  unless the field is required
