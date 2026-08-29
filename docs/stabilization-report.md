# Workbench Runtime Stabilization — Final Report

*Companion to `docs/engine-assessment.md` (the prior analysis) and
`/Users/ferdinandhoske/.claude/plans/sequential-imagining-ullman.md` (the
approved plan this report executes). No code was rewritten wholesale —
every change below is the smallest fix or seam that satisfied the stated
invariant, verified by a passing test before moving to the next item.*

## A. Change summary

### A1 — Restored test fixtures (`apps/reading_tracker`, `apps/gratitude_log`, `apps/tasks`)
**Problem:** `apps/` was absent from the working tree; `tasks`/`reading_tracker`/
`gratitude_log` were never committed to git at all (confirmed via `git log --
apps/`), so 15 tests across `api/` and `build/` failed on `open ../apps: no
such file or directory`.
**Fix:** Authored three minimal fixtures (`manifest.json` + a trivial
`frontend/dist/index.html`) with field shapes derived exactly from what the
existing tests assert (e.g. `tasks/task.priority` enum excludes `"urgent"`
because a test asserts it's rejected).
**Why minimal:** deterministic, test-derived shapes — no new design
decisions, no speculative fixture content.
**Affected:** `apps/reading_tracker/`, `apps/gratitude_log/`, `apps/tasks/` (new).

### A2 — Confirmed baseline
`go build`/`go vet` were already clean; every prior test failure was
fixture-related, not a logic bug. Confirmed via re-run after A1.

### A3 — New regression tests (schema/, SQL-injection boundary, migration)
- `schema/parse_test.go` (new): 12 tests locking down `schema.Parse` —
  previously zero coverage on the most load-bearing package in the repo.
- `api/security_test.go` (new): 2 tests proving filter values and field
  names can't alter generated SQL, exercised through the public HTTP path.
- `migrate/apply_test.go`: added `TestApplyRequiredFieldWithBackfillWitnessEndToEnd`
  (the one witness shape not previously tested at the `Apply` level) and
  `TestVerifySchemaMatchesAfterEveryMigrationShape` (the load-bearing check
  behind B1's exact-match design — see below).
- Confirmed, not re-tested: uniqueness-over-duplicates is already covered
  end-to-end by the existing `TestApplyRestoresOnExecutionFailure`; the
  suspected `build.Reconcile` transition bug is traced and **confirmed not a
  bug** (the completion-shortcut can only ever observe a job already in
  `StateActivating`, which is a valid transition source — already covered
  by `TestReconcileCompletesADurablyActivatedJobInstead`).

### B1 — Boot-time manifest/database consistency check
**Problem:** `registry.Load` assumed a manifest and its `data.db` were
already consistent; `ApplyDDL`'s `CREATE TABLE IF NOT EXISTS` is a true
no-op against an existing, differently-shaped table, so a hand-edited
manifest could silently be served against a database that no longer
matched it.
**Fix:** `Store.VerifySchema(app *schema.App) error` (`store/store.go`) —
reuses existing internal column helpers to compute each entity's expected
physical column set and diffs it against `PRAGMA table_info` output,
exact-match. `registry.Load` calls it immediately after `ApplyDDL` and
skips (never serves) a mismatched app, using the same `LoadResult`
mechanism already used for validation failures.
**Why exact-match, and why it's safe:** verified first, empirically, with
`TestVerifySchemaMatchesAfterEveryMigrationShape` — an app driven through a
rename, a safe add, a destructive backfilled add, and a destructive drop
(covering both `migrate/`'s native ALTER path and its table-rebuild path)
shows zero false positives, because `migrate/`'s DDL generation shares
`materialize`'s column conventions rather than hand-rolling its own.
**Affected:** `store/store.go`, `registry/boot.go`. New tests: `store/store_test.go`
(4), `migrate/apply_test.go` (1), `registry/boot_test.go` (1).

### B2 — Panic recovery
**Problem:** zero `recover()` calls anywhere; a panic in any single request
handler would crash the whole process — every app this binary serves, not
just the offending one.
**Fix:** `recoverMiddleware` in `cmd/pocketknife/main.go` — stdlib-only,
wraps the composed handler, logs method/path/panic value/stack server-side,
returns a bare 500, never exposes anything to the client.
**Affected:** `cmd/pocketknife/main.go`. New: `cmd/pocketknife/main_test.go` (3 tests).

### B3 — `build.Deploy` rollback gap
**Problem:** the `Transition(..., StateActivating, ...)` and `PromoteActive`
failure paths in `build/deploy.go` returned bare errors with no call to the
existing `rollback()` closure, even though both run *after* a data migration
has committed and a frontend has been fully built — directly contradicting
the function's own documented "single rollback contract."
**Fix:** extended both failure paths to call the same `rollback()` closure
already used by the earlier frontend-build-failure path. The final
`Transition(..., StateReady, ...)` failure path was investigated and left
untouched — `build.Reconcile` already finishes that specific case correctly
on next boot (existing test confirms).
**Affected:** `build/deploy.go`. New tests: `build/deploy_test.go` (2), using a
minimal, self-resetting test-only fault injector added to `build.Store`
(`failTransitionTo`, `failNextPromoteActive`) — the only way to trigger these
exact failures deterministically without a genuine platform-DB I/O failure.

### B4 — `ExtractBundle` byte-cap
**Problem:** the cumulative byte cap was checked against the tar header's
*declared* size, never against bytes actually written; `io.Copy`'s real byte
count was discarded. No error path cleaned up a partial extraction.
**Fix:** `writeBundleFile` now copies with a hard per-call ceiling
(`io.CopyN(out, r, maxBytes+1)`) and returns actual bytes written; the cap is
enforced against that real count. `ExtractBundle` now removes `destDir`
entirely on any failure (verified safe: all three real callers treat
`destDir` as exclusively owned by the call).
**Affected:** `build/bundle.go`. New tests: `build/bundle_test.go` (2).

### D — `domain.RowStore` interface
One interface (`Insert/GetByID/Exists/List/Update/Delete`), defined in the
consumer package (`domain/store.go`), satisfied by `*store.Store` with zero
changes to `store/`. Scoped to exactly this surface after inspecting every
caller: `migrate/` never touches CRUD at all (only `Open/Path/Close/
Checkpoint/RunMigration`), so it gets no interface and needs none.
`registry.RegisteredApp.Store` stays concrete, since it's shared by both
CRUD-only and migration-only consumers.

### C1 — Shared field coercion (`domain/coerce.go`)
**Problem:** `api/coerce.go`'s `coerce()` and `sandbox/data.go`'s
`coerceValue()` were confirmed rule-for-rule identical (same
text/integer/real/boolean/datetime/enum/reference-exists logic for every
type), differing only in error-return shape.
**Fix:** `domain.CoerceFieldValue` + `domain.DefaultStoreValue` are now the
single source of truth. `api/coerce.go` is deleted; its logic lives in
`domain` and is called from the new `api/api.go`. `sandbox/data.go`'s
`coerceValue`/`defaultStoreValue` are now three-line adapters translating
`*domain.FieldError` into the exact same wire-error text sandbox has always
produced (verified: all 24 `sandbox/` tests pass unchanged, including the
error-message-format-sensitive ones).
**Explicitly not merged:** `validate/semantic.go`'s `validateDefault` — a
manifest-authoring-time check on an already-parsed Go value, not a runtime
wire-value check — stays separate, per the task's own caution against
conflating the two.

### C2/C3 — Transport-neutral domain operations + thin HTTP adapter
**Problem:** all CRUD business logic (field loop, defaulting, coercion,
store calls, response shaping) was inlined directly inside `api/api.go`'s
five `http.HandlerFunc` bodies.
**Fix:** `domain.Create/Get/List/Update/Delete` (`domain/operations.go`) —
plain Go functions with no `http.Request`/`ResponseWriter` dependency,
resolving app/entity/operation through the registry internally and
returning a structured `*domain.OpError{Kind, Message, Issues}`.
`api/api.go`'s five handlers are now genuinely thin: parse HTTP-specific
bits (path values, query string, body bytes) → call the matching
`domain.X` → map `OpError.Kind` to the exact pre-existing HTTP status/code/
message. `api/query.go`'s already-transport-neutral query parsing moved
into `domain/query.go` verbatim.
**Behavior preserved:** all 10 pre-existing `api/api_test.go`/`gate_test.go`
tests pass with zero modification.
**Two narrow, deliberate, untested-corner behavior changes** (see §D below
for why these were accepted): (1) unknown-field-in-body detection now
short-circuits with 400 *before* calling `domain.Create`/`Update` (so it
can never combine with a per-field validation issue in one response,
unlike before — no test ever asserted the combined-issue shape); (2) for
`Create`/`Update`, the request body is now decoded before resolving the
app/entity, so a simultaneously-malformed-body-and-unknown-app request now
gets `400 invalid_body` instead of `404 app_not_found` (again, untested,
and arguably no less correct).
**New:** `domain/operations_test.go` (7 tests) — the executable proof that
these operations work with zero `net/http` in the call chain.

### E — Deployment serialization moved to `build.Store`
**Problem:** the per-app-id lock lived only in `deployapi.Server`'s own
map; `build.Deploy`/`build.Bootstrap` had no internal protection, so any
other caller (the CLI, a future MCP deploy tool) could race a concurrent
deploy for the same app id.
**Fix, and a bug caught during implementation:** initially moved the lock
*inside* `Deploy`/`Bootstrap` themselves — this broke `deployapi`'s
redeploy-vs-firstInstall decision, because that decision (`reg.App(appID)`)
needs to be re-evaluated *after* acquiring the lock, not before, or a second
concurrent request for a brand-new app id would take the wrong branch and
fail with "app directory already exists" (caught by re-deriving the
existing `TestDeployConcurrentRequestsForSameNewAppSerialize` test by hand
before it ran — the actual test run then confirmed the corrected design).
**Final design:** `build.Store.LockApp(appID) func()` is the one shared
lock, and `deployapi.handleDeploy` holds it across *both* the branch
decision and the call — exactly mirroring what its own removed lock did,
just backed by `build.Store`'s map instead of a private one. `Deploy`/
`Bootstrap` themselves carry no internal lock.
**Explicitly out of scope:** cross-process serialization (a running
`pocketknife serve` vs. a concurrent `pocketknife build` CLI invocation) —
each process opens its own `*build.Store` with its own empty lock map; an
in-memory mutex cannot bridge that, and per the task's own "no distributed
locks, this is a local runtime" instruction, no cross-process primitive was
added. Documented as an accepted limitation, not a bug.
**Affected:** `build/store.go`, `deployapi/deployapi.go`. New tests:
`build/store_test.go` (2, covering same-app-id serialization and
different-app-id independence, both passing under `-race`).

### Localhost-safe default
`-addr` now defaults to `127.0.0.1:8080` (was `:8080`, which Go binds to
every interface). `Makefile`'s `ADDR` default updated to match.
`README.md`/`CLAUDE.md` updated with the exact trust-model language
requested, and `/platform/` auth is untouched.

### Sandbox status documentation
Documentation-only. Added an explicit "implemented and tested; not yet
wired into any live entry point" status line to `README.md`'s feature list
and its "Sandboxed functions" section, and to the top-of-package doc
comments in `sandbox/sandbox.go` and `broker/broker.go` (which previously
read as unconditionally active). No code or behavior changed.

---

## B. Architecture summary

```
                         ┌────────────────┐
                         │ HTTP (api/)    │  thin adapter: path/query/body parsing,
                         └───────┬────────┘  OpError → status/code/message mapping
                                 │
                         ┌───────▼────────┐
                         │ domain/        │  Create/Get/List/Update/Delete
                         │ operations.go  │  resolve app+entity+op via registry,
                         └───────┬────────┘  classify store errors → OpError
                                 │
                    ┌────────────▼────────────┐
                    │ domain/coerce.go        │  CoerceFieldValue, DefaultStoreValue
                    │ (shared with sandbox/)  │  — the one rule set for every type
                    └────────────┬────────────┘
                                 │
                         ┌───────▼────────┐
                         │ domain.RowStore│  interface: Insert/GetByID/Exists/
                         │ (domain/store) │  List/Update/Delete
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ *store.Store   │  the only implementation; VerifySchema
                         │ (SQLite)       │  guards boot-time consistency
                         └────────────────┘

Unchanged adjacent systems:
  registry/  — App(id) lookup; Load calls ApplyDDL then VerifySchema
  migrate/   — Diff → Classify → Witness → Snapshot → Execute (untouched semantics)
  build/     — Deploy/Bootstrap; LockApp shared lock; rollback now covers the
               two previously-bare-error late-stage failure paths
  sandbox/   — dataCreate/Read/List/Update/Delete call *store.Store directly
               (unchanged orchestration) but coerceValue/defaultStoreValue are
               now thin adapters over domain.CoerceFieldValue/DefaultStoreValue
```

`sandbox/` deliberately does **not** call `domain.Create/Get/List/Update/
Delete` — only the coercion primitive is shared (see §D, "sandbox
orchestration scoping"). `domain.Create`/`Update` are shaped to make a
future sandbox migration a pure adapter addition if one is ever wanted:
they always collect every field issue (a superset of sandbox's fail-fast
need) and don't bake in unknown-field rejection (an HTTP-body-strictness
policy, not a coercion rule).

## C. Tests

```
$ go build ./...   → clean
$ go vet ./...     → clean
$ go test ./...    → ok, all 19 packages with test files
$ go test ./... -race → ok, all 19 packages (sandbox ~220s under race, otherwise fast)
```

254 passing test functions/subtests (`go test ./... -v | grep -c '^--- PASS'`),
zero failures, zero skips. Package-by-package: every package that had tests
before this work still passes unchanged; `domain/` (new, 7 tests),
`schema/` (new, 12 tests), `cmd/pocketknife` (new, 3 tests), plus targeted
additions in `api/` (+2), `migrate/` (+2), `registry/` (+1), `store/` (+4),
`build/` (+6 across deploy/bundle/store).

No remaining failures.

## D. Deferred items

**Bug / reliability issue — none remaining that this phase committed to fixing.**
Everything in the plan's priority list (1–11) was completed.

**Architectural prerequisite (intentionally not built, and why):**
- A second `RowStore` implementation (Postgres) — the seam exists; nothing
  implements it. Building it now would be exactly the kind of speculative
  work the task explicitly excluded.
- A `SnapshotStore`-style interface for `migrate/`'s narrower surface
  (`Open/Path/Close/Checkpoint/RunMigration`) — not introduced, because
  nothing currently needs to swap that implementation and `migrate/`'s own
  storage independence was explicitly asked to be left where it already is.
- Sandbox → domain/MCP unification — `sandbox/data.go` still owns its own
  CRUD orchestration (only coercion is shared). Wiring it onto
  `domain.Create/Get/List/Update/Delete` is a real, bounded follow-up, not
  attempted here per the task's explicit "do not wire it into the main
  runtime merely to eliminate the label 'unused'."

**Future feature (explicitly out of scope, not attempted):**
- An `mcp/` package calling `domain.*` directly. Nothing in this phase
  builds it — see §E below for exactly what it would need.
- App-deletion/purge lifecycle, manifest-version history/audit log beyond
  the existing snapshot window — unrelated to this phase's scope.

**SaaS concern (explicitly out of scope by design, not a regression):**
- Cross-process deploy serialization (CLI vs. a live `serve` process) — see
  Work Package E above. No distributed lock was added, per instruction.
- Multi-tenancy, workspace auth, Postgres, per-app process isolation — none
  attempted; all explicitly excluded by the task.

**Two narrow, deliberate, untested-corner HTTP behavior changes** from the
`domain` extraction are documented in §A's C2/C3 entry above — both traded a
small amount of combined-error-reporting nicety for a materially simpler
adapter, and neither is pinned by any existing test.

## E. MCP readiness

> **Can a future MCP package now call Workbench runtime operations
> directly, without internally making HTTP requests and without
> duplicating CRUD validation logic?**

**Yes, for the CRUD data-plane.** An MCP tool package would import
`pocketknife/domain` and `pocketknife/registry`, hold a `*registry.Registry`,
and call `domain.Create(reg, appID, entityName, body)` / `Get` / `List` /
`Update` / `Delete` exactly as `api/api.go` now does — no `net/http`
anywhere in that call chain, and the *only* field-validation logic in the
whole binary is `domain.CoerceFieldValue`, already shared with `sandbox/`.
Each of these returns a `*domain.OpError{Kind, Message, Issues}`; an MCP
transport would write its own small `Kind → MCP error shape` mapping,
mirroring what `api/api.go`'s `writeOpError` already does for HTTP — the
same one-file, one-function pattern, not a redesign.

**One remaining, explicitly-scoped gap:** sandboxed WASM function
invocation is not part of this reachable surface — `sandbox/data.go` still
calls `*store.Store` directly with its own (intentionally different)
orchestration, not `domain.Create/Get/List/Update/Delete`. An MCP transport
wanting to expose *that* capability would need either (a) a second, thin
`domain`-based adapter sandbox could also use — architecturally
straightforward, since `domain.Create`/`Update` were deliberately shaped
(always-collect issues, no built-in unknown-field policy) to make this a
pure-addition later — or (b) to keep sandboxed functions as a separate,
smaller surface indefinitely. Neither choice was made in this phase, per
the task's explicit instruction not to wire sandbox into the main runtime
"merely to eliminate the label unused."
