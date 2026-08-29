## 1. Capability model in the manifest schema and validator

- [x] 1.1 Add `schema.Function` (id, name, entry, `*Capabilities`) and `schema.App.Functions`;
      `App.Function(name)`/`FunctionByID(id)` lookups mirroring the existing entity lookups
- [x] 1.2 Add `schema.Capabilities` (data scopes, exact-match network allow-list, model
      boolean) and `schema.DataScope` (entity + restricted operation subset); nil-safe
      `Allows(entityID, op)` and `AllowsDomain(host)`
- [x] 1.3 Extend `manifest.schema.json` with a `functions` array and parse it in
      `schema/parse.go`
- [x] 1.4 `validate/semantic.go`: reject a duplicate function id/name; reject a data scope
      whose entity doesn't resolve, is repeated within one function, or requests an operation
      the entity itself does not allow; reject a repeated network domain within one function
- [x] 1.5 Tests covering every rejection path plus a fully valid function declaration

## 2. Sandbox runtime: isolation and resource limits

- [x] 2.1 Create `sandbox` package; `Sandbox` wraps one shared `wazero.Runtime` configured
      with `WithMemoryLimitPages` and `WithCloseOnContextDone(true)`, plus WASI preview1 and
      the capability-gated `pocketknife` host module instantiated once
- [x] 2.2 `Options` (memory limit, timeout, max input/output bytes) with package defaults
      applied via `withDefaults`; `Compile` caches a compiled module by absolute path
- [x] 2.3 `Invoke`: builds a per-call `invocation` threaded through `context.Context`, clears
      wazero's default `_start` auto-invocation, manually calls `_initialize` if exported,
      then calls `run` — a fresh module instance per invocation, discarded after, so no two
      invocations ever share mutable state
- [x] 2.4 `classifyErr` maps a timed-out or memory-exhausted invocation to `ErrTimeout`/
      `ErrResourceExhausted` (and anything else to `ErrTrapped`), always as a host-level error
      from `Invoke`, never as a guest-reported `Result`
- [x] 2.5 Tests: infinite loop killed by timeout; allocation bomb killed by the memory cap;
      the host process and a fresh invocation on the same `Sandbox` are unaffected by either
      kill; filesystem access, environment reads, and raw socket dials all fail unconditionally
      regardless of declared capabilities; the guest module's only imports are
      `wasi_snapshot_preview1` and `pocketknife`

## 3. Capability-gated host interfaces

- [x] 3.1 `host.go`: the `pocketknife` host module (`input_len`/`input_read`/`output_write`/
      `result_read` plumbing, plus the three gated calls); `finishGated` translates a
      handler's `(body, code)` into the wire value the guest sees, with `codeDenied` always
      clearing the pending buffer so a denial carries no detail
- [x] 3.2 `data.go`: `data_call` re-checks `Capabilities.Allows(entity, op)` before resolving
      the entity or touching the store; create/read/list/update/delete each mirror the
      generic API's coercion and error classification (bad-request vs backend-error) without
      importing `api` (avoiding an import cycle)
- [x] 3.3 `network.go`: `network_fetch` re-checks `Capabilities.AllowsDomain(host)` before
      building any request; the host always decides the scheme (`https://`), never the guest;
      redirects are never auto-followed (`CheckRedirect` returns `http.ErrUseLastResponse`)
- [x] 3.4 `model.go`: `model_call` re-checks `Capabilities.Model` before ever calling
      `broker.Call`, so a denied function has no code path to the broker at all
- [x] 3.5 `sandbox.Options.Transport` seam: nil in production (defaults to
      `http.DefaultTransport`), lets tests point `network_fetch` at a local TLS test server
      without weakening the host-decided `https://`-only scheme or certificate validation
- [x] 3.6 Tests: data access denied out-of-scope and for the wrong operation, allowed and
      round-tripping create/read/update/delete correctly (including a post-delete read
      returning a null row as success, not a backend error); network denied for a
      non-allow-listed domain and for a function with no network capability at all, allowed
      and round-tripping a real HTTPS request/response including headers, and proven to not
      auto-follow a redirect; a function with data access but no network capability is denied
      for every domain it tries, including ones it has no reason to know about

## 4. Model broker

- [x] 4.1 Create `broker` package; `Caller` interface (`Call(ctx, prompt) (string, error)`) as
      the seam between `Broker` and a real provider; `Broker.Call` is nil-receiver-safe and
      returns `ErrNotConfigured` for a nil caller
- [x] 4.2 `httpCaller`: posts `{"prompt": ...}` with a bearer token to a configured endpoint;
      the token field is unexported with no accessor, JSON tag, or `String` method anywhere
      in the package
- [x] 4.3 Tests: `Call` delegates to the configured `Caller`; a nil `Broker` and a `Broker`
      with no `Caller` both return `ErrNotConfigured`; the token is never exposed by any
      public method (static check); the dynamic counterpart — a guest function's observable
      output never contains a token-shaped value even when granted model access and fed an
      adversarial prompt — lives in the sandbox package's end-to-end tests

## 5. Capability consent derivation

- [x] 5.1 Create `consent` package; `Capabilities` (deduplicated `DataGrant`s, network
      domains, model bool) with `IsEmpty`
- [x] 5.2 `Union(app)`: pure function collapsing every declared function's capabilities into
      one deterministic, sorted set, independent of declaration order
- [x] 5.3 `Delta` and `Widened(oldApp, newApp)`: pure diff of two versions' unions, reporting
      only additions; `RequiresReconsent` signals whether any widening occurred at all
- [x] 5.4 Tests: union correctly collapses overlapping/duplicate grants across functions; a
      version that only narrows capabilities produces an empty, non-reconsent-triggering
      delta; a version that adds a new entity grant, a new domain, or model access each
      independently trigger `RequiresReconsent`; a data scope and a network domain held by the
      same function are both visible on the same `Capabilities` value, not just discoverable
      separately

## 6. Gate / acceptance suite

- [x] 6.1 Out-of-scope data read/write is denied and never reaches the store
- [x] 6.2 Network access to a domain outside the function's allow-list is unreachable
- [x] 6.3 Model access without declaring the capability is denied before the broker is ever
      touched, and the provider token is never observable in any guest-visible output
- [x] 6.4 A function with data access but no matching network grant has no domain it can
      exfiltrate through; the capability union makes a data+network combination on one
      function visible together rather than only discoverable by cross-referencing
- [x] 6.5 Resource exhaustion (infinite loop, allocation bomb) is killed cleanly, with the
      host process and subsequent invocations on the same `Sandbox` unaffected
- [x] 6.6 Host escape (filesystem, environment, raw socket) is impossible by construction,
      regardless of declared capabilities
- [x] 6.7 The legitimate positive case — a function with the right capabilities performing
      data CRUD and a real allow-listed network round trip — works end-to-end
- [x] 6.8 Consent derivation and re-consent-on-widening (`consent.Union`/`Widened`) work
      against real multi-function manifests
- [x] 6.9 Run `go build ./... && go vet ./... && gofmt -l . && go test ./...`; confirm all
      green
