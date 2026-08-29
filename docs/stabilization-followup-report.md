# Workbench Runtime Stabilization — Follow-up Report

*Closes three remaining correctness/boundary issues identified in
`docs/stabilization-report.md`. No other engine code was touched.*

## Boot consistency

**What the old verification actually covered**: `Store.VerifySchema` (unchanged by this
pass) compares only column *names* via `PRAGMA table_info` — it scans `notnull`, `type`,
and `dflt_value` into local variables but never compares them. It catches a missing or
extra column; it cannot see a constraint-only change.

**Reproducibility**: confirmed with five new characterization tests in
`store/store_test.go` (`TestVerifySchemaDoesNotDetect*`) — materialize one version of an
app, then call `VerifySchema` with a second version that changes only `required`,
`unique`, `min`/`max`, an enum's value set, or a reference's `target`/`onDelete`. In every
case `VerifySchema` reports no mismatch. Yes, a hand-edited manifest can pass it while the
database enforces different semantics.

**Mechanism now preventing it**: a persisted schema fingerprint
(`schema.Fingerprint`, `schema/fingerprint.go`) — a canonical representation of exactly
the parts of the manifest that determine materialized schema semantics (entity/field
stable ids, type, required, unique, min/max, enum values, reference target/onDelete),
sorted deterministically and SHA-256 hashed. Deliberately excluded: `Name` (a rename
moves no data — storage is id-keyed), entity `Operations` (an API-surface concern), and a
field's `Default` value (`materialize` never emits a SQL `DEFAULT` clause; confirmed by
grep before deciding this). The fingerprint is stored in a new `_schema_meta` singleton
table *inside each app's own `data.db`* (`store/store.go`), so a migration's snapshot
restore reverts it for free, and it is written:

- atomically with the schema change itself, inside the same migration transaction
  (`migrate/execute.go`'s `Execute`, via `store.WriteAppliedFingerprintTx`) — a pure
  rename skips this because it can't change the fingerprint's value;
- right after a fresh `ApplyDDL` in `build.Bootstrap` (first install);
- or adopted at boot (`registry.Load` → `checkSchemaFingerprint`) when none exists yet.

`registry.Load` now runs `VerifySchema` *and* the fingerprint check before registering any
app; either failing skips that app (never serving it) without stopping its siblings.

**Legacy databases (no recorded fingerprint)**: `registry.Load` adopts the manifest's
fingerprint as the baseline **only after** `VerifySchema` has already shown the
database's columns are consistent with it — never blindly. This is a one-time,
documented, accepted limitation: a legacy database that was *already* constraint-mismatched
(same columns, different semantics) at the moment it's upgraded past this point adopts
that mismatched fingerprint silently, since nothing before this point could have proven
otherwise; any *further* drift from that point on is caught exactly like a fully
up-to-date app's would be. Proven by
`registry/boot_test.go`'s `TestLegacyAppWithoutFingerprintAdoptsBaselineWhenStructurallyConsistent`
and `TestLegacyAppAlreadyMismatchedAdoptsOnceThenDetectsFurtherDrift`.

## Deployment boundary

Final call flow:

```text
HTTP (deployapi) / CLI (cmd/pocketknife) / future MCP
                    ↓
           build.ApplyDeployment          <- the one public boundary
                    ↓
              bst.LockApp(appID)          <- held across decide + call
                    ↓
      re-check reg.App(appID) (fresh, under the lock)
                    ↓
         Bootstrap (new)  |  Deploy (existing)
```

`ApplyDeployment` (`build/apply_deployment.go`) validates the manifest once to learn the
app id, holds `LockApp` across both the existence re-check and the call, and — for the
Deploy branch only — extracts the frontend bundle first (hiding the asymmetry that
Bootstrap does this itself but Deploy assumes it's already on disk). `deployapi` no
longer decides Bootstrap-vs-Deploy or locks anything itself; its old `redeploy`/
`firstInstall` methods are deleted. The CLI's `runBuild` now calls `ApplyDeployment` too
(with `bundle: nil`, since it works off an already-on-disk frontend), though it keeps its
own pre-flight "unknown app" check for a clear CLI error message before ever calling in.

`Deploy` and `Bootstrap` remain exported primitives, not renamed to unexported — a
deliberate choice, not an oversight: this package's own ~30 existing tests call them
directly to exercise fine-grained failure/rollback behavior that would be awkward to
reach any other way, and renaming them would have meant mechanically touching every one
of those call sites for no behavioral gain (the actual risk — an external caller
racing the Bootstrap-vs-Deploy decision — is fully closed by updating the two real
external callers, deployapi and the CLI, to go through `ApplyDeployment`). Both now
carry an explicit doc-comment pointer to `ApplyDeployment` as the preferred entry point.

A bug was caught and fixed *during* this work, before it ever shipped: the first version
of `ApplyDeployment` acquired the lock *inside* `Deploy`/`Bootstrap` themselves, which
broke `deployapi`'s decision — a second concurrent request for a brand-new app id would
decide against stale information and fail with "app directory already exists" instead of
correctly falling through to a redeploy. Fixed by moving the lock to wrap the
decision *and* the call from one level up, in `ApplyDeployment` itself; `Deploy`/
`Bootstrap` carry no internal locking.

New tests in `build/apply_deployment_test.go` prove, deterministically (via a test-only
`Store.testHoldLock` checkpoint hook — added because an earlier wall-clock-based version
of these tests was flaky under `-race`'s added scheduling overhead, not because of any bug
in the lock itself):

- `TestApplyDeploymentSerializesConcurrentInstallsOfTheSameNewApp` — two concurrent
  installs of the same new app id serialize; the app ends up registered exactly once.
- `TestApplyDeploymentSerializesConcurrentDeploysOfAnExistingApp` — two concurrent
  redeploys of an existing app never overlap.
- `TestApplyDeploymentDoesNotSerializeDifferentAppIDs` — a different app id's deployment
  completes promptly while another app's lock is held open, proving independence.

Explicitly not built: cross-process serialization (a running `pocketknife serve` vs. a
concurrent `pocketknife build` CLI invocation) — each process still opens its own
`*build.Store` with its own empty lock map; this is a documented, accepted limitation,
consistent with "no distributed locks, this is a local runtime."

## HTTP semantics

Both corner cases are now a deliberate, documented, regression-tested contract (see the
"Deliberate contract" comments on `unknownFieldIssues` and `decodeBody` in `api/api.go`):

1. **Unknown fields in a create/update body.** *Chosen behavior*: short-circuit with 400
   before `domain.Create`/`Update` is ever called, reporting only the unknown-field
   issue(s) — never combined with a separate field's domain-validation issue, and never
   risking an insert/update when the request doesn't match the schema's shape at all.
   *Rationale*: cleanest separation of "is this body even addressed to this schema" (a
   wire-transport question, answered entirely in `api/`) from "is this data valid" (a
   domain question) — domain's contract stays simple (if it runs, every key was already
   known), and a future MCP transport can make an entirely different wire-shape decision
   (e.g. rejecting extra properties at its own tool-schema layer) without touching domain
   at all. *Pinned by*: `TestUnknownFieldShortCircuitsBeforeDomainValidation`
   (`api/http_contract_test.go`), which also asserts no row is inserted.

2. **Malformed body against an unknown app.** *Chosen behavior*: `400 invalid_body`, not
   `404 app_not_found` — body decoding happens before any app/entity resolution for every
   create/update request, no exceptions. *Rationale*: this isn't an arbitrary ordering
   choice, it's the structural consequence of the adapter's data flow — there is no
   well-formed `map[string]json.RawMessage` to hand `domain.Create`/`Update` until the
   body has already been decoded, so a strict "HTTP parsing gates domain resolution"
   pipeline is both simpler to reason about and requires no special-casing. *Pinned by*:
   `TestMalformedBodyReportedBeforeAppResolution` (`api/http_contract_test.go`), covering
   both POST and PATCH.

## Validation

```
$ go build ./...    → clean
$ go vet ./...       → clean
$ go test ./...      → ok, all 19 packages with test files, 0 failures
$ go test ./... -race → ok, all 19 packages, 0 failures, 0 data races
```

New test files/additions this pass: `schema/fingerprint.go` (+`fingerprint_test.go`, 5
tests), `store/store_test.go` (+5 characterization tests), `registry/boot_test.go` (+4
tests), `migrate/apply_test.go` (+3 tests), `build/apply_deployment.go`
(+`apply_deployment_test.go`, 3 concurrency tests), `api/http_contract_test.go` (2
tests). No test was skipped or weakened.

## Remaining issues

- Cross-process deploy serialization (CLI vs. a concurrently running server) is not
  implemented — explicitly out of scope, documented above and in code.
- The legacy-fingerprint-adoption blind spot (an already-mismatched pre-existing database
  silently adopts its mismatched manifest's fingerprint once, on upgrade) is a documented,
  accepted, one-time limitation, not a bug — there is no prior signal that could have
  caught it.
- `Deploy`/`Bootstrap` remain exported; a caller inside the `build` package (or a
  hypothetical future caller who imports `build` directly) can still call them without
  going through `ApplyDeployment`'s lock. No current caller does this outside the
  package's own tests.

No new roadmap items are proposed. Per the task's closing instruction, no further engine
cleanup follows this report.
