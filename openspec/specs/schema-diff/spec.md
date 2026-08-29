# schema-diff Specification

## Purpose

Compute a deterministic, stable-id-keyed structural diff between two validated manifests and
mechanically classify each resulting operation as safe or destructive.

## Requirements

### Requirement: Structural diff keyed by stable id

The system SHALL compute a structural diff between an old and a new validated manifest,
matching entities and fields entirely by stable `id`, and produce a typed, ordered
`Changeset` of operations. The diff SHALL detect, for entities and fields: added, dropped,
renamed (same id, different name), type-changed, and constraint-changed (nullability change,
enum value membership change, reference target change, uniqueness change).

#### Scenario: Same id different name is a rename

- **WHEN** a field keeps id `fld_x` but changes name from `a` to `b`
- **THEN** the changeset contains a rename operation for that field and no drop/add pair

#### Scenario: New id is an add, missing id is a drop

- **WHEN** the new manifest introduces a field with an id absent from the old, and omits an id
  present in the old
- **THEN** the changeset contains one add operation and one drop operation, each carrying the
  affected stable id

#### Scenario: Type and constraint changes are detected

- **WHEN** a field's type changes from `integer` to `real`, or a field changes from nullable
  to required, or an enum value is removed
- **THEN** the changeset records the corresponding type-changed or constraint-changed
  operation with its before and after shape

### Requirement: Changeset is the verification ground truth

The computed `Changeset` SHALL stand alone as the authoritative description of structural
change. The system SHALL provide a seam for a future caller-annotated changeset to be
verified against this computed diff, and SHALL leave that verification unimplemented in this
phase.

#### Scenario: Diff is reproducible from manifests alone

- **WHEN** the same old and new manifests are diffed
- **THEN** the resulting changeset is deterministic and derived only from the manifests, with
  no external hint or annotation consulted

### Requirement: Mechanical safe/destructive classification

The system SHALL classify every changeset operation as **safe** (information-preserving,
auto-applied) or **destructive** (information-losing, gated). The classification SHALL be
purely a function of the operation's structure. Safe operations include: add entity, add
nullable field or field with a default, rename entity or field, widen numeric type, add an
enum value, relax a constraint (not-null → nullable). Destructive operations include: drop
entity, drop field, narrow a type, remove an enum value, `nullable → not-null` without a safe
default, re-target or break a reference, and add a uniqueness constraint. When ambiguous, the
system SHALL classify an operation as destructive.

#### Scenario: Information-preserving op is safe

- **WHEN** a nullable field is added, a field is renamed, or an `integer` field is widened to
  `real`
- **THEN** the operation is classified safe

#### Scenario: Information-losing op is destructive

- **WHEN** a field is dropped, a `real` field is narrowed to `integer`, an enum value is
  removed, or a uniqueness constraint is added
- **THEN** the operation is classified destructive

### Requirement: Caller annotations cannot override classification

The system SHALL ignore any caller-supplied class hint and use only the computed
classification. A changeset deliberately annotated to mark a destructive operation as safe
SHALL still be treated as destructive.

#### Scenario: Mis-annotated destructive op stays gated

- **WHEN** a caller submits a changeset annotating a drop-field operation as safe
- **THEN** the engine classifies it destructive and gates it behind witness, confirm, and
  snapshot
