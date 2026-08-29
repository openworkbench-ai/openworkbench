## Context

Phase 1 (schema/validate/materialize/store/api/registry) and Phase 3 (migrate) are built and
gated; Phase 4 (this change) adds the only way an app gets server-side logic beyond generic
CRUD. The central design constraint, stated as plainly as possible because every decision
below follows from it: **the manifest declares capabilities, the sandbox enforces them, and
nothing running inside the sandbox is trusted.** A function's `Capabilities` block in the
manifest is metadata, not a permission grant in itself — it only becomes a permission the
moment the sandbox's own host-call handlers independently check it, every single call, against
the live request being made. This matters concretely because the eventual author of a
function's code (Phase 5) is an LLM, and an LLM-authored or LLM-repaired function is exactly
the kind of input this system must assume is adversarial, regardless of how well-intentioned
the manifest's declared capabilities look.

## Goals / Non-Goals

**Goals:**
- Total isolation by default: no filesystem, no environment, no raw network, no shared
  mutable state across invocations, for every function, with no per-function opt-out.
- Capability checks that happen at the one host boundary a function can reach, independently
  of and never substituting for manifest validation.
- Hard resource limits that kill a runaway function cleanly, with the host process and every
  other invocation provably unaffected.
- A denial that leaks nothing: not which capability was missing, not whether the entity or
  domain even exists, beyond the bare fact that the call was refused.
- A model broker that a function can use without the function (or anything it returns) ever
  being able to observe the credential the broker uses on its behalf.
- A derived, not authored, view of what an app's functions can collectively do, so a future
  consent UI sees the real composite power of the app, not just one function's view of it.

**Non-Goals:**
- No LLM authoring or repair of function code — Phase 5. This phase only makes running
  arbitrary already-compiled code safe.
- No consent UI or shell that actually renders capability deltas to a user — Phase 6. This
  phase only computes the union and the delta as pure data.
- No broker/self-host hardening beyond a sound baseline (retry policy, rate limiting,
  multi-provider failover) — Phase 7.
- No shared-manifest install flow, no multi-user or per-function auth.
- No frontend network access of any kind, in this phase or any later one: every outbound
  network call an app makes goes through a sandboxed function, never through hand-authored
  frontend code running in a browser.

## Decisions

- **WebAssembly via wazero, hand-authored Go compiled by the stock toolchain, is the isolation
  primitive.** wazero is pure Go (no CGo), which keeps the trusted core a single static
  binary with no native dependency surface to audit. Compiling functions with
  `GOOS=wasip1 GOARCH=wasm` means a function author writes ordinary Go against a small,
  explicit host ABI (seven `//go:wasmimport`-declared functions) rather than a bespoke DSL.
- **A function's guest module must be built with `-buildmode=c-shared`, never the default
  `exe` buildmode.** The default buildmode links the wasm entry point as `_start`, which runs
  the guest's `main()` and then calls `proc_exit` — a one-shot command, not a reactor — so
  wazero closes the module after that single automatic call and no exported function (`run`)
  is reachable again. `c-shared` links `_initialize` instead, which only sets up the Go
  runtime and returns normally, leaving the module open for `Invoke` to call `run` as many
  times as the host wants (in this design, exactly once per `Invoke`, since each call gets a
  fresh module instance anyway — but the module must at least be *capable* of staying open
  past its own initialization). `sandbox.Invoke` reflects this directly: it clears wazero's
  default `startFunctions` (so `_start` is never auto-invoked) and manually calls
  `_initialize` if the module exports it, then calls `run`.
- **Every invocation gets its own module instance, instantiated fresh and closed after.**
  `Sandbox` caches only the *compiled* module (by absolute path); `Invoke` instantiates a new
  instance of it on every call and discards that instance's linear memory, globals, and any
  per-invocation host-side state (`invocation`, built fresh and threaded through `context.
  Context`) when the call returns. Two concurrent or sequential invocations of the same
  function never observe each other's input, output, or pending host-call result.
- **Resource limits are enforced by the runtime, not by guest cooperation.** A fixed
  `MemoryLimitPages` (16 MiB by default) is set on the wazero runtime config itself, so a
  guest cannot allocate past it regardless of what it tries; a per-`Invoke` `context.
  WithTimeout` combined with `WithCloseOnContextDone(true)` means a runaway loop's module is
  forcibly closed at the wall-clock deadline, not merely asked to stop. `classifyErr` maps
  both outcomes (and any other trap) to a sentinel (`ErrTimeout`, `ErrResourceExhausted`,
  `ErrTrapped`) the host gets back as a normal Go error from `Invoke` — never a guest-reported
  `Result`, because the guest never got the chance to report anything.
- **Three host calls, not a general syscall surface.** `data_call`, `network_fetch`, and
  `model_call` are the only capability-gated operations; everything else a function can
  observe (`input_len`/`input_read`/`output_write`/`result_read`) is plumbing with no
  capability question attached. Each gated call's handler re-resolves the request against
  `inv.fn.Capabilities` itself — it does not trust that the manifest validator already
  confirmed the scope makes sense, because the sandbox's job is to be correct even if that
  validation step were buggy, skipped, or bypassed entirely.
- **A denial is sentinel-only, with the pending buffer left empty.** `codeDenied` (`-1`)
  never carries a detail body, unlike `codeBadRequest`/`codeBackendError`, which do. This
  closes an oracle: if a denial for "wrong operation on an entity you do declare" looked any
  different from a denial for "an entity you've never even heard of," a function could binary
  -search its way to learning about scopes it was never granted, one denial at a time.
- **`network_fetch` decides the scheme; the guest never does.** The allow-list is a bare
  hostname, and the handler always builds `https://` + host + path itself — there is no
  guest-controlled URL and therefore no scheme-downgrade path to exploit. Redirects are never
  auto-followed (`CheckRedirect` returns `http.ErrUseLastResponse`): if an allow-listed host
  serves a redirect to a host that was never granted, following it automatically would let
  the allow-listed origin act as a confused deputy into that ungranted host. The raw,
  un-followed response (including its `Location` header) is handed back to the guest, which
  must issue a fresh `network_fetch` for the new location if it wants to follow it — and that
  fresh call gets re-gated against the allow-list exactly like any other.
- **The model broker's token has no path back out, by construction, not by convention.** The
  `httpCaller` that holds a real provider token has no JSON tag, no `String` method, no
  accessor, and no field reachable from `Caller`'s single `Call(ctx, prompt) (string, error)`
  method — so there is no code path inside `model_call`'s handler, regardless of what a
  function's prompt says or what a malicious provider's response contains, that could put the
  token into a function's observable output. `Broker.Call` is also nil-receiver-safe,
  returning `ErrNotConfigured` for a host process started without a token, which is
  indistinguishable on the wire from "I have a token but chose to deny you" — a function can't
  use the error to learn whether model access is configured at all on a host it wasn't
  granted access to.
- **Capability consent is two pure functions over the manifest, never authored state.**
  `consent.Union(app)` collapses every function's declared `Data`/`Network`/`Model` into one
  deduplicated, sorted set — visible together, which is the point: a future consent surface
  must be able to see "this app reads task data *and* can reach attacker.example" as one
  combined fact about the app, not two capabilities a user would have to mentally combine
  across separate function entries themselves. `consent.Widened(oldApp, newApp)` diffs two
  versions' unions and reports only additions — a capability a new version *drops* is never a
  re-consent event, since it can only narrow what the app could already do, mirroring how
  `migrate.Diff` trusts no caller hint about what changed, only the two schemas themselves.
- **The exfiltration surface is a property of the union, not of any single capability.** No
  single host call is exfiltration-shaped on its own — reading data is not dangerous in
  isolation, and neither is reaching a network host — but a function that holds *both* a data
  scope and a network domain in the same `Capabilities` value is the shape that matters for a
  consent reviewer. `consent.Union` and `schema.Capabilities` both expose `Data` and `Network`
  on the same value precisely so this combination is structurally visible rather than
  something a reviewer has to notice by cross-referencing two separate declarations.

## Risks / Trade-offs

- **A future host call added to the ABI must repeat the same re-validate-don't-trust pattern,
  or the boundary quietly weakens.** Mitigated by keeping the pattern mechanical and
  identical across all three current gated calls (`handle*Call(inv, reqBytes) ([]byte, int32)`
  feeding into one shared `finishGated`), so a fourth gated call has an obvious template to
  follow rather than a blank page to improvise on.
- **`-buildmode=c-shared` is an easy thing to forget when authoring a new guest fixture or,
  eventually, when the Phase 5 LLM-authoring pipeline compiles a generated function.**
  Mitigated for this phase by a structural test (`TestGuestOnlyImportsHostAndWASI`) and by
  documenting the requirement directly in `sandbox.Invoke`'s own comments; Phase 5's compile
  step inherits the same requirement and should assert it the same way `sandbox_test.go` does.
- **wazero's `WithMemoryLimitPages` is a hard ceiling on linear memory, not on host-side
  buffering.** `MaxInputBytes`/`MaxOutputBytes` independently cap what the host will accept
  into or accumulate from a guest, specifically so a guest cannot use unbounded
  `output_write` calls to exhaust host memory even while staying under its own wasm memory
  limit.
- **A redirect-following guest could still be tricked into leaking request data to an
  allow-listed host that turns out to behave maliciously within its own allowed scope** — this
  is accepted as the nature of an allow-list: once a domain is granted, the sandbox's job is
  to enforce the allow-list boundary itself, not to police what an allowed counterparty does
  with a request it was always entitled to receive.

## Migration Plan

Additive: a manifest with no `functions` array behaves exactly as it did before this change —
`schema.App.Functions` is `nil`, `consent.Union` returns an empty `Capabilities`, and no app
without functions ever touches the `sandbox` or `broker` packages. There is no data migration:
functions hold no persistent state of their own, and the manifest's new `functions` section is
purely additive JSON Schema.

## Open Questions

None blocking. The LLM-authoring pipeline (Phase 5) and the consent shell that actually
surfaces `consent.Widened` to a user (Phase 6) are explicitly deferred; this phase's seams
(`schema.Function`/`Capabilities`, `consent.Union`/`Widened`, `sandbox.Options.Transport` for
test injection) are left clean for them.
