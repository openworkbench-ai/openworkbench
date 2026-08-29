# capability-consent Specification

## Purpose

Compute, purely from a manifest, the full set of capabilities an app's functions could
collectively exercise, and exactly what a new manifest version would add over a prior one —
so a future consent surface can show a user the real composite power of an app, including
combinations (like data access alongside network access) that only become visible when every
function's declarations are considered together, rather than authoring or trusting any
out-of-band record of what was previously approved.

## Requirements

### Requirement: The capability union is a deterministic, pure function of the manifest

The system SHALL compute an app's capability union as the deduplicated set of every entity and
operation grant, every network domain, and the overall model-access flag, taken across every
function the app declares. The result SHALL be independent of the order in which functions or
their individual grants are declared, and SHALL be empty for an app with no functions or for a
function declaring no capabilities.

#### Scenario: An app with no functions has an empty capability union

- **WHEN** the union is computed for an app that declares no functions
- **THEN** the result reports no data grants, no network domains, and no model access

#### Scenario: Overlapping grants across functions are deduplicated

- **WHEN** two functions declare overlapping or identical data grants or network domains
- **THEN** the union reports each distinct grant or domain exactly once

#### Scenario: The union does not depend on declaration order

- **WHEN** the same set of functions and grants is declared in a different order
- **THEN** the computed union is the same

#### Scenario: A function with no capabilities contributes nothing to the union

- **WHEN** a function declares no capabilities at all
- **THEN** that function contributes no grants, domains, or model access to the union

### Requirement: A data grant and a network domain on the same function are visible together

The system SHALL expose an app's data grants and network domains on the same union value, so
that a function holding both a data scope and a network capability presents as one combined
fact about the app rather than two facts only discoverable by separately inspecting each
function's declaration.

#### Scenario: A function with both data and network capabilities reports both in the same union

- **WHEN** a single function declares both a data scope and a network domain
- **THEN** the app's capability union reports that data grant and that domain together as part
  of the same computed result

### Requirement: Widening between two manifest versions is computed, not authored

The system SHALL compute the exact set of capabilities a new manifest version's union adds
over a prior version's union, considering only additions. A capability present in the prior
version but absent from the new one SHALL never appear in this result, since dropping a
capability can only narrow what the app could already do.

#### Scenario: A new data grant in the new version is reported as added

- **WHEN** a new version's union includes a data grant not present in the prior version's union
- **THEN** that grant appears in the computed delta

#### Scenario: A new network domain in the new version is reported as added

- **WHEN** a new version's union includes a network domain not present in the prior version's
  union
- **THEN** that domain appears in the computed delta

#### Scenario: Model access turning on is reported as added

- **WHEN** the prior version's union has no model access and the new version's union does
- **THEN** the computed delta reports model access as newly added

#### Scenario: Dropping a capability never appears in the delta

- **WHEN** a new version's union has strictly fewer grants, domains, or no longer has model
  access compared to the prior version
- **THEN** the computed delta reports no additions at all

#### Scenario: Identical versions produce a delta with no additions

- **WHEN** the delta is computed between two manifest versions with identical capability
  unions
- **THEN** the result reports no additions in any category

### Requirement: Any addition in the delta signals that re-consent is required

The system SHALL report that re-consent is required whenever the computed delta contains any
addition at all — a new data grant, a new network domain, or model access turning on — and
SHALL report that re-consent is not required when the delta contains none of these, including
when no delta exists at all.

#### Scenario: Any single category of addition triggers the reconsent signal

- **WHEN** the delta contains an addition in any one of data grants, network domains, or model
  access
- **THEN** the reconsent signal reports true

#### Scenario: A delta with no additions does not trigger the reconsent signal

- **WHEN** the delta contains no additions in any category
- **THEN** the reconsent signal reports false

#### Scenario: No delta at all does not trigger the reconsent signal

- **WHEN** no delta value exists to evaluate
- **THEN** the reconsent signal reports false rather than failing
