# Phase 4 — what's built but not yet wired

**Status as of commit `4eb111c` (Add Phase 4 sandboxed functions).**

Phase 4 delivered the capability model and the enforcement machinery for
sandboxed server-side functions as a set of standalone, unit-tested packages.
The security boundary exists and is exercised by tests exactly as an external
caller would hit it — but **none of it is reachable by a running server yet.**
There is no HTTP endpoint to invoke a function, and the binary never constructs
a `Sandbox` or a `Broker`.

This doc records precisely what exists and what is left to connect, so the
integration can be picked up later without re-deriving the surface.

## What IS implemented (and tested in isolation)

| Package | Responsibility | Tested |
|---|---|---|
| `schema/` | `Function`, `Capabilities`, `DataScope` types; `Capabilities.Allows` / `AllowsDomain`; `App.Function` / `App.FunctionByID`; manifest parsing of `functions` | via parser tests |
| `validate/` | `validateCapabilities` — hard gate at load time: unique fn id/name, data-scope entities resolve, no duplicate scopes/domains, scope can't exceed the entity's own allowed operations | yes |
| `sandbox/` | The real boundary: wazero runtime with no FS/env/network, fixed 7-call host ABI, capability re-checks, per-invocation limits (16 MiB / 5 s / 1 MiB in-out), redirect-pinning, isolation | yes (`sandbox_test`, external pkg) |
| `broker/` | The only path to a model provider; token held unexported, never observable; `Caller` seam + `httpCaller` | yes |
| `consent/` | `Union` (capability surface) and `Widened`/`RequiresReconsent` (re-consent delta) — pure functions of the manifest, for the *future* Phase 6 consent shell | yes |

Key public entry points already in place:

```go
// sandbox
sb, err := sandbox.New(sandbox.Options{})            // zero value = defaults
cm, err := sb.Compile(ctx, absWasmPath)              // cached by abs path
res, err := sb.Invoke(ctx, cm, fn, st, app, brk, input)
//   fn  *schema.Function, st *store.Store, app *schema.App, brk *broker.Broker
//   res.Output []byte, res.Failed bool
//   error is non-nil only for host/infra failures (ErrTimeout /
//   ErrResourceExhausted / ErrTrapped), never a guest business-logic failure.

// broker
brk := broker.New(broker.NewHTTPCaller(endpoint, token)) // token from host env
// broker.New(nil) is valid → Call returns ErrNotConfigured

// consent (Phase 6, not Phase 5)
caps  := consent.Union(app)
delta := consent.Widened(oldApp, newApp) // delta.RequiresReconsent()
```

## What is NOT wired up (the work left to do)

### 1. No function-invocation HTTP endpoint
`cmd/pocketknife/main.go` registers `/apps/`, `/builds/`, `/ui/` only. There is
no route that runs a function. Nothing outside `*_test.go` imports
`pocketknife/sandbox` — confirm with:

```sh
grep -rl 'pocketknife/sandbox' --include='*.go' . | grep -v _test   # → empty
```

**To add:** a handler (e.g. `POST /apps/{app}/functions/{name}`) that resolves
the app from the registry, looks up the function via `ra.Schema.Function(name)`,
and calls `sandbox.Invoke`. The intended home is the `api` package — note the
deliberate import direction: **`api` imports `sandbox`, never the reverse**
(this is why `sandbox/data.go` duplicates coercion logic instead of sharing
`api/coerce.go`). Don't break that by having `sandbox` reach back into `api`.

### 2. No `Sandbox` lifecycle owned by the server
`sandbox.New` is never called in `main.go`. A single `*sandbox.Sandbox` should
be built once at boot (it holds the shared wazero runtime + compiled-module
cache) and `Close`d on shutdown. It needs to be handed to whatever serves the
function endpoint.

### 3. No `Broker` constructed from the environment
`broker.NewHTTPCaller(endpoint, token)` exists but is never called. `main.go`
reads no model-provider env vars. **To add:** read endpoint + token from env at
boot (e.g. `POCKETKNIFE_MODEL_ENDPOINT` / `POCKETKNIFE_MODEL_TOKEN` — names TBD),
build the broker, and pass it into `Invoke`. If the env is absent, `broker.New(nil)`
is the correct fallback (model calls then surface `ErrNotConfigured` to the guest
as a backend error, which is the intended behaviour).

### 4. `Function.Entry` path resolution + compilation caching
`Function.Entry` is a path **relative to the app's directory** and must already
be a built `.wasm` (pocketknife never compiles on-box). The app's directory is
`registry.RegisteredApp.Dir` (note: `schema.App` itself carries no `Dir`). The
wiring must resolve `filepath.Join(ra.Dir, fn.Entry)` and pass the absolute path
to `sb.Compile`. Decide when to compile: lazily on first invocation, or eagerly
at boot/activation. (`Compile` already caches by absolute path and is
concurrency-safe, so lazy is fine.)

### 5. Wire format between HTTP and guest is host-internal, not yet HTTP-facing
The request/response shapes the guest exchanges over the host ABI
(`dataRequest`, `networkRequest`, `modelRequest`, and the `input`/`output`
byte buffers) are defined inside `sandbox/`. The HTTP endpoint needs its own
decision on how an HTTP caller's body maps to the `input []byte` handed to
`Invoke`, and how `res.Output` maps back to the HTTP response. This is
unspecified so far.

### 6. Consent shell — explicitly deferred to Phase 6
`consent.Union` / `consent.Widened` are built and tested but have **no caller**.
They are intended for a future consent/approval UI that gates an app (or an app
update that *widens* capabilities) before it runs. Not part of the function-
invocation wiring; listed here only so it isn't mistaken for dead code.

## Sanity checks once wired

- `grep -rl pocketknife/sandbox --include='*.go' . | grep -v _test` should now
  list `api` (and/or `cmd`).
- An end-to-end call: a manifest with a function declaring a `data` scope →
  `POST` to the new endpoint → row created/read through the sandbox, with a
  call **outside** the declared scope returning a denial that carries no body.
- A function declaring `model` with no broker configured should get a backend
  error (not a panic), and the token must never appear in any response.
- Extend `test_project_hub.sh` (or add a sibling script) to cover invocation —
  it currently predates Phase 4 and exercises none of it.

## Reference

- OpenSpec change: `openspec/changes/2026-06-22-add-sandboxed-functions/`
  (proposal, design, tasks, and delta specs for `function-capability-model`,
  `sandbox-execution`, `model-broker`, `capability-consent`).
- Test guest fixture: `sandbox/testdata/guestsrc/driver` (compiled by
  `sandbox_test`'s `TestMain` with `GOOS=wasip1 GOARCH=wasm
  -buildmode=c-shared`).
