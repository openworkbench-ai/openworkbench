# sandbox-execution Specification

## Purpose

Be the real security boundary for a function's code — not the manifest. Every function body
is treated as adversarial: it runs with no filesystem, no environment, no raw network, and no
notion of any other invocation's state, behind a fixed, capability-checked host interface that
is the only way out of the WebAssembly module it runs in. A function's declared capabilities
are re-checked here, at the moment of each gated call, independently of whatever the manifest
validator already confirmed.

## Requirements

### Requirement: Every invocation is isolated from every other invocation

The system SHALL instantiate a fresh module instance for every call to a function, with its
own linear memory, and SHALL discard that instance and all per-invocation host-side state when
the call returns. No invocation, concurrent or sequential, of the same or a different function,
SHALL observe another invocation's input, output, or pending host-call result.

#### Scenario: Concurrent invocations of the same function do not cross-contaminate output

- **WHEN** many invocations of the same compiled function run concurrently with distinct
  inputs
- **THEN** each invocation's output corresponds only to its own input

#### Scenario: A later invocation never sees an earlier invocation's pending host-call result

- **WHEN** one invocation completes a gated host call and a later, unrelated invocation makes
  no gated call of its own
- **THEN** the later invocation's output contains no trace of the earlier invocation's result

### Requirement: A function gets no filesystem, no environment, and no raw network

The system SHALL grant a function's module no filesystem access, no environment variables, and
no ability to open a raw network connection outside the capability-gated `network_fetch` call,
regardless of what capabilities that function declares in the manifest.

#### Scenario: A filesystem read always fails

- **WHEN** a function's code attempts to read any file from the host filesystem
- **THEN** the attempt fails

#### Scenario: An environment read always comes back empty

- **WHEN** a function's code attempts to read a host environment variable
- **THEN** the read returns no value

#### Scenario: A raw socket dial always fails, even for a network-capable function

- **WHEN** a function's code attempts to open a raw TCP connection directly, bypassing
  `network_fetch`
- **THEN** the attempt fails, regardless of whether that function declares any network
  capability

### Requirement: Resource limits are hard ceilings enforced by the runtime

The system SHALL enforce a fixed linear-memory limit and a wall-clock timeout on every
invocation, independent of anything the function's code does. A function that runs past its
timeout or attempts to allocate past its memory limit SHALL be forcibly stopped, and the
failure SHALL surface to the caller as a host-level error, never as a function-reported
result.

#### Scenario: An infinite loop is killed by the timeout

- **WHEN** a function's code never returns control to the host
- **THEN** the invocation is forcibly stopped once its timeout elapses and the caller receives
  a timeout error

#### Scenario: An allocation bomb is killed by the memory limit

- **WHEN** a function's code attempts to allocate memory without bound
- **THEN** the invocation is forcibly stopped once it exceeds its memory limit and the caller
  receives a resource-exhaustion error

#### Scenario: A killed invocation does not affect the host or later invocations

- **WHEN** an invocation has been forcibly stopped for a timeout or memory-limit violation
- **THEN** the same `Sandbox` correctly serves a subsequent, unrelated, legitimate invocation

### Requirement: Capability-gated host calls re-check the calling function's capabilities every time

The system SHALL expose exactly three capability-gated host calls — data access, network
fetch, and model access — and SHALL independently verify the calling function's declared
capabilities against the specific request being made before performing any of the
corresponding action, never trusting that manifest validation already confirmed the request is
in scope.

#### Scenario: A data request outside the function's declared scope is denied before the store is touched

- **WHEN** a function calls for a data operation on an entity, or an operation on an entity, it
  was not granted
- **THEN** the call is denied and the underlying store is never queried or modified

#### Scenario: A network request to a host outside the function's allow-list is denied before any request is sent

- **WHEN** a function calls network fetch for a host not in its declared allow-list
- **THEN** the call is denied and no network request is made

#### Scenario: A model call from a function that did not declare model access is denied before the broker is touched

- **WHEN** a function calls the model host interface without having declared model access
- **THEN** the call is denied and the model broker is never invoked

#### Scenario: A request within a function's declared capabilities succeeds end to end

- **WHEN** a function makes a data, network, or model call that is within its declared
  capabilities
- **THEN** the call succeeds and returns the real result of that action

### Requirement: A denial carries no information beyond the fact of denial

The system SHALL respond to a denied capability-gated call with a fixed sentinel and no
additional detail — no error message, no distinguishable body — so that a function cannot use
response content to learn anything about capabilities, entities, operations, or domains it was
not granted.

#### Scenario: Denials for different unauthorized requests are indistinguishable on the wire

- **WHEN** a function is denied for two different reasons (e.g. an unscoped entity vs. a wrong
  operation on a scoped entity)
- **THEN** both denials carry the same sentinel and no detail body, with nothing in the
  response that would let the function tell the reasons apart

### Requirement: Network fetch decides the request scheme and never auto-follows a redirect

The system SHALL always issue an allow-listed network request over HTTPS regardless of any
scheme a function might attempt to specify, and SHALL return any redirect response to the
function unfollowed rather than automatically following it to a new host.

#### Scenario: A redirect to a non-allow-listed host is not automatically followed

- **WHEN** an allow-listed host's response is a redirect to a different host
- **THEN** the function receives the raw redirect response, including its target location, and
  the sandbox does not itself issue a request to that other host

### Requirement: The guest module's host-facing surface is limited to the documented ABI

The system SHALL ensure a compiled function module's only imports come from the WASI preview1
module and the sandbox's own capability-gated host module — no other import surface is
available to a function.

#### Scenario: A compiled function imports nothing outside the documented host modules

- **WHEN** a function's compiled module's imports are inspected
- **THEN** every import's module name is either the WASI preview1 module or the sandbox's host
  module
