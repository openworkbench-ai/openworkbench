## Why

Phase 1's API is the only server-side logic an app has had so far: generic CRUD over a
validated schema, with no way for an app to run its own code. Real apps need custom
server-side behavior — derived fields, side effects on write, calls to a model — but the
moment a manifest can name arbitrary code, that code has to be treated as adversarial: an
LLM-authored or LLM-repaired function (Phase 5) is not a trusted input, and "the manifest
declares it's safe" is not a security boundary. This change adds the function runtime itself,
built so that the *manifest's declarations are advisory and the sandbox's enforcement is the
only thing that matters* — every claim a function's capabilities make is independently
re-checked at the one narrow host interface a function can reach, never assumed from the
manifest that granted it. The LLM that will eventually author these functions is still
entirely out of scope; this phase only has to make running someone else's code safe, not
generating it.

## What Changes

- **A WebAssembly sandbox is the real security boundary.** Functions are hand-authored Go,
  compiled with the stock toolchain to `wasip1`/`wasm` and run under a pure-Go `wazero`
  runtime with no CGo. A function gets no filesystem, no environment, no raw network, and no
  notion of any other invocation's state — every guest module is instantiated fresh per
  invocation and discarded afterward, so two calls to the same function never share mutable
  state even when run concurrently.
- **Resource limits are hard, not advisory.** Every invocation runs under a wall-clock timeout
  and a fixed linear-memory cap; an infinite loop is killed by the timeout, an allocation bomb
  is killed by the memory cap, and either kind of kill leaves the host process and every other
  invocation completely unaffected.
- **A capability model in the manifest, re-validated, not just parsed.** A function declares
  data scopes (entity + the subset of that entity's own already-enabled operations), an
  exact-match network allow-list, and a model-access boolean. The validator rejects a scope
  that doesn't resolve to a real entity, repeats an entity or domain, or requests an operation
  the entity itself does not allow — catching authoring mistakes before a function ever runs,
  without weakening the sandbox's own enforcement, which never trusts that this validation
  already happened.
- **Three capability-gated host calls, denial-only on the wire.** `data_call`, `network_fetch`,
  and `model_call` are the only way out of a function's module. Each independently re-checks
  the calling function's declared capabilities before touching the store, the network, or the
  model broker. A denial carries no information beyond the fact of denial — no error detail,
  no distinguishable response shape — so a function cannot use response content as an oracle
  to fingerprint entities, operations, or domains it was never granted.
- **The model broker is the only thing that ever holds a provider token.** A function that
  declares model access gets a prompt-in-text-out call; the token itself has no field, method,
  or code path in the broker that could hand it back out, so there is nothing for even a
  malicious function (or a compromised provider response) to leak.
- **Derived, not authored, consent capabilities.** A pure function of the manifest computes the
  exact union of every capability any function in the app could exercise — collapsed across
  functions so "reads task data" and "can reach attacker.example" are visible together as one
  combined fact about the app, never as two capabilities that happen to coexist invisibly —
  and a second pure function diffs two versions' unions to flag exactly what a new version
  would add, which is what a future consent shell (Phase 6) re-prompts on.

## Capabilities

### New Capabilities
- `function-capability-model`: the manifest schema for declared functions (data scopes,
  network allow-list, model boolean) and the validator rules that catch authoring mistakes
  against an app's own entities and operations.
- `sandbox-execution`: the wazero-backed runtime that actually enforces capabilities —
  per-invocation isolation, hard resource limits, and the three capability-gated host calls —
  regardless of what the manifest declares.
- `model-broker`: the single, narrow path from a capability-gated function to a model
  provider, with the provider token unreachable from any function or response.
- `capability-consent`: pure derivation of an app's full capability union from its manifest,
  and of the exact delta a new version would widen, for a future consent shell to act on.

### Modified Capabilities
<!-- None: this phase adds a new runtime alongside the unmodified Phase 1/3 API, materialize,
     and store contracts. No existing capability changes behavior. -->

## Impact

- **New code:** `sandbox/` (wazero runtime, capability-gated host module, resource limits),
  `broker/` (model-provider call seam, token holder), `consent/` (capability union and widen
  diff); `schema.Function`/`schema.Capabilities`/`schema.DataScope` and the corresponding
  manifest JSON-schema additions; `validate/semantic.go` gains per-function capability checks.
- **Modified code:** none of the frozen Phase 1 (`api/`, `store/`, `materialize/`) or Phase 3
  (`migrate/`) contracts change; this phase adds a manifest section and a runtime alongside
  them, never altering how an existing app without functions behaves.
- **Data:** none. Functions hold no state of their own between invocations; nothing new is
  persisted beyond the manifest's own `functions` array.
- **Dependencies:** `github.com/tetratelabs/wazero` (pure Go, no CGo) is the one new
  dependency.
- **Out of scope, left as clean seams:** LLM authoring/repair of function code (Phase 5),
  the consent UI/shell that actually renders and re-prompts on `consent.Widened` (Phase 6),
  broker/self-host hardening beyond a sound baseline (Phase 7), shared-manifest install
  (Phase 8), multi-user/per-function auth. The frontend has, and will continue to have, no
  network capability of its own — every outbound call a function-using app makes goes through
  this sandbox, never through hand-authored frontend code.
