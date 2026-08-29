# function-capability-model Specification

## Purpose

Let a manifest declare the server-side functions an app runs and exactly what each one is
allowed to touch — which entities and operations, which network hosts, whether it may call a
model — and catch authoring mistakes against the app's own entities and operations at
validation time. This declaration is advisory metadata for the sandbox to enforce, never an
enforcement mechanism by itself: a manifest that validates cleanly only describes what a
function may attempt, and the `sandbox-execution` capability is what actually decides what it
can.

## Requirements

### Requirement: A function declares an id, name, entry module, and capabilities

The system SHALL allow a manifest to declare zero or more functions, each with a stable id, a
name, an `entry` naming a pre-built `.wasm` module path relative to the app's directory, and a
`capabilities` block. Function ids and names SHALL each be unique within one manifest.

#### Scenario: Duplicate function id is rejected

- **WHEN** two functions in the same manifest declare the same id
- **THEN** validation fails for the second occurrence

#### Scenario: Duplicate function name is rejected

- **WHEN** two functions in the same manifest declare the same name
- **THEN** validation fails for the second occurrence

### Requirement: A data scope must resolve to a real entity and never exceed its operations

The system SHALL allow a function's capabilities to declare data scopes, each naming an entity
by its stable id and a subset of operations on it. Validation SHALL reject a scope whose
entity id does not resolve to an entity declared in the same manifest, reject a scope that
names the same entity more than once within one function, and reject a scope that requests an
operation the named entity itself does not allow.

#### Scenario: A data scope naming an unknown entity is rejected

- **WHEN** a function declares a data scope whose entity id does not match any entity in the
  manifest
- **THEN** validation fails with an unresolved-reference error

#### Scenario: A repeated entity within one function's data scopes is rejected

- **WHEN** a function declares two data scopes for the same entity id
- **THEN** validation fails with a duplicate-data-scope error

#### Scenario: A scope requesting an operation the entity disallows is rejected

- **WHEN** a function's data scope requests an operation that the target entity's own
  `operations` list does not include
- **THEN** validation fails with a scope-exceeds-entity error

#### Scenario: A scope requesting only operations the entity allows is valid

- **WHEN** a function's data scope requests only operations present in the target entity's own
  `operations` list, on an entity that exists in the manifest
- **THEN** validation succeeds for that scope

### Requirement: The network allow-list is an exact-match set of hostnames

The system SHALL allow a function's capabilities to declare a list of hostnames it may reach.
Validation SHALL reject a domain repeated more than once within one function's list. No
wildcard, pattern, or partial match is part of this capability — matching is exact-string only,
enforced at the sandbox boundary, not interpreted here.

#### Scenario: A repeated domain within one function is rejected

- **WHEN** a function's network allow-list contains the same hostname twice
- **THEN** validation fails with a duplicate-domain error

#### Scenario: Distinct domains are valid

- **WHEN** a function's network allow-list contains only distinct hostnames
- **THEN** validation succeeds for that list

### Requirement: Model access is a single boolean with no parameters

The system SHALL allow a function's capabilities to declare a boolean `model` flag granting
access to the model broker. There are no scoped variants of this capability — a function
either may call the broker or may not.

#### Scenario: A function with no functions block behaves exactly as before this capability existed

- **WHEN** a manifest declares no `functions` array at all
- **THEN** the app's schema model has a nil/empty function list and validation imposes no
  additional requirements
