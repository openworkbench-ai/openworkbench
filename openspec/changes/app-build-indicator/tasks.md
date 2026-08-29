## 1. Backend fix

- [x] 1.1 In `build/bootstrap.go`, call `bst.EnsureAppMeta(app.ID, app.Name, app.Emoji, app.Color)` immediately after `bst.Transition(job.ID, StateBuilding, "")` succeeds, treating a failure from `EnsureAppMeta` as non-fatal (log and continue, matching `deployapi.go:134-136`).
- [x] 1.2 Confirm the `fail()` closure's staging cleanup and job-failure transition still run unmodified after this addition (the `app_meta` row must persist even when `fail()` is invoked later).

## 2. Tests

- [x] 2.1 Add/extend a `build` package test asserting that after `Bootstrap`'s job reaches `building`, `bst.GetAppMeta(appID)` returns a non-nil row (before the rest of the bootstrap — frontend build, materialize, activation — completes). Simulate this by asserting the row exists using the job's `building` state as a checkpoint, e.g. via a test hook or by checking state right after a deliberately-failing bootstrap (see 2.2) leaves the row behind.
- [x] 2.2 Add a test for a failing first install (e.g. invalid frontend bundle or materialize error) asserting the app's `app_meta` row still exists afterward and `GET /platform/registry`-equivalent lookup reports `buildState: "failed"` for that app id.
- [x] 2.3 Add/extend a `platform` package test hitting `GET /platform/registry` mid-bootstrap (or against the state left by a test in 2.1/2.2) to confirm the endpoint includes the app with the correct `buildState` and no other registry fields cause a panic when other data (frontend asset dir, manifest version) isn't set yet.
- [x] 2.4 Run the existing `deployapi` and `build` test suites (`go test ./build/... ./deployapi/... ./platform/...`) to confirm no regression in the redeploy (`build.Deploy`) or retry-after-failure paths.

## 3. Manual verification

- [x] 3.1 Run `make build`, start the server, and drive a real first-time app creation through the shell (New App Sheet → Plan Review → approve) while watching `GET /platform/registry` (or the launcher UI) to confirm the new app's tile shows the "Building…" progress ring within one poll cycle (~3s) of approval, before the build finishes. Done directly against `POST /deploy` (bypassing the agent) with a real running server: observed `buildState` go from absent to `"building"` in ~66ms and stay `"building"` through a ~12.6s frontend copy before flipping to `"ready"`.
- [x] 3.2 Force a first-install failure (e.g. a manifest that fails frontend build) and confirm the launcher shows the failed-build indicator instead of no tile at all. Verified live: a broken bundle (missing entry file) makes `/deploy` return 500, and `GET /platform/registry` afterward shows the app with `buildState: "failed"` (previously would have shown nothing or `"none"` due to a pre-existing bug in `handleList`, fixed as part of this change).
