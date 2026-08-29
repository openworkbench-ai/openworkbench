# schema-migration Specification

## Purpose

Apply a classified changeset to an app's database transactionally and reversibly, snapshotting
before destructive work, gating destructive operations behind declarative witnesses, and
exposing the flow headlessly.

## Requirements

### Requirement: Snapshot before every destructive migration

The system SHALL take a byte-for-byte file copy of an app's `data.db` before applying any
migration containing a destructive operation. The snapshot SHALL be WAL-consistent: the
system SHALL checkpoint with `PRAGMA wal_checkpoint(TRUNCATE)` before copying, or copy the
WAL alongside the main file. The system SHALL provide rollback that restores the database
byte-for-byte from a snapshot.

#### Scenario: Snapshot precedes destructive execution

- **WHEN** a migration containing a destructive operation is applied
- **THEN** a snapshot of `data.db` is created before any schema change is executed

#### Scenario: Undo restores byte-for-byte

- **WHEN** a snapshot is taken under WAL, the database is mutated, and the snapshot is
  restored
- **THEN** the restored database is byte-identical to the snapshot and its data is intact

#### Scenario: Retention keeps the last N snapshots

- **WHEN** more than N migrations with snapshots have occurred
- **THEN** only the most recent N snapshots are retained, per the documented retention policy

### Requirement: Transactional all-or-nothing execution

The system SHALL apply a classified changeset to a single app's database inside one
transaction. On any failure the system SHALL leave the database unchanged (rolling back the
transaction, and restoring the snapshot when one was taken) and SHALL keep the prior schema
registration. The system SHALL never leave an app half-migrated.

#### Scenario: Failure restores prior state

- **WHEN** any operation in a changeset fails during execution
- **THEN** the database is restored to its pre-migration state and the previously registered
  schema remains in effect

#### Scenario: Safe additive ops use native statements

- **WHEN** a safe migration adds a nullable field or a new entity
- **THEN** the executor uses `ADD COLUMN` or `CREATE TABLE` and existing data is untouched

#### Scenario: Type and constraint changes use table rebuild

- **WHEN** a migration changes a column's type or constraints
- **THEN** the executor performs the SQLite table-rebuild pattern (create new id-named table,
  `INSERT … SELECT` with coercion, drop old, rename new, rebuild indexes) and runs
  `PRAGMA foreign_key_check` before committing

### Requirement: Declarative witnesses gate destructive operations

The system SHALL require a declarative witness for each destructive operation before it may
run. Witnesses SHALL be drawn from a closed vocabulary: a type-narrowing coercion
(truncate / round / fail), a backfill default for `nullable → not-null` over existing nulls,
and a remap for rows holding a removed enum value. The system SHALL NOT accept arbitrary or
Turing-complete witnesses. A destructive operation lacking a required witness SHALL refuse to
run with no default and no silent coercion.

#### Scenario: Destructive op without witness refuses

- **WHEN** a `nullable → not-null` migration is applied to a column containing nulls and no
  backfill witness is supplied
- **THEN** the migration refuses to run and the database is unchanged

#### Scenario: Witness coercion is applied during rebuild

- **WHEN** a `real → integer` narrowing migration supplies a truncate coercion witness
- **THEN** the executor applies the coercion during the table rebuild and the migration
  completes

### Requirement: Headless apply-changeset flow

The system SHALL expose a single apply-changeset path that, in order: validates the new
manifest, diffs it against the current one, classifies the operations, requires witnesses and
an explicit confirmation when any destructive operation is present, takes a snapshot, executes
within one transaction, and re-registers the new schema; and on any failure restores the
snapshot and keeps the prior registration. The flow SHALL be available through an internal
`migrate` package and a `pocketknife migrate` CLI subcommand. The system SHALL NOT add any new
HTTP surface for migration. No LLM, frontend, or shell SHALL participate in this flow.

#### Scenario: Destructive migration requires explicit confirm

- **WHEN** a migration containing a destructive operation is invoked without the explicit
  confirmation flag
- **THEN** the flow refuses to execute and reports the destructive operations and required
  witnesses

#### Scenario: Safe migration auto-applies

- **WHEN** a migration containing only safe operations is invoked
- **THEN** the flow applies it without requiring confirmation and re-registers the new schema

#### Scenario: CLI drives the flow

- **WHEN** `pocketknife migrate` is run against an app with an evolved manifest
- **THEN** the apply-changeset flow runs and no new HTTP endpoint is involved

### Requirement: SQLite version floor is enforced

The system SHALL pin a minimum SQLite version of 3.35 (for `ADD COLUMN` / `DROP COLUMN`
support) and SHALL assert that the linked SQLite version meets this floor at boot, failing
fast otherwise.

#### Scenario: Boot asserts the version floor

- **WHEN** the runtime boots
- **THEN** it verifies the linked SQLite version is at least 3.35 and aborts if it is lower
