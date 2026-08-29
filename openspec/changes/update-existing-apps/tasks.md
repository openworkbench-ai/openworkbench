## 1. Backend frontend-source store

- [x] 1.1 Add source-artifact storage in `build/` (sibling to `frontend.go`): write extracted source to `apps/<id>/sources/<jobID>/`, immutable per job, reusing `build.ExtractBundle` containment
- [x] 1.2 Pin source to the active build's jobID via the existing `active_builds` pointer; "current source" resolves through that pointer (rollback repoints source with the build)
- [x] 1.3 Extend the build-artifact prune so retiring a build also retires its `sources/<jobID>/`
- [x] 1.4 Ensure source is stored opaquely — no install/build/execute server-side
- [x] 1.5 Decide source presence tracking (a `has_source` flag vs existence of `sources/<jobID>/`) and implement it
- [x] 1.6 Tests: source-bearing deploy stores under jobID; sourceless deploy stores nothing; rollback makes prior source current; prune retires source with build; traversal/symlink source archive is rejected

## 2. Deploy ingest accepts optional source (agent-deploy-ingest delta)

- [x] 2.1 Parse an optional `source` part in `deployapi/multipart.go`
- [x] 2.2 Route the `source` part through the source store in `deployapi.go` for both Bootstrap and Deploy paths, keyed on `jobId`
- [x] 2.3 Keep behavior identical when `source` is absent (deploy still succeeds, nothing stored)
- [x] 2.4 Tests: deploy with bundle+source stores both and response is unchanged; deploy without source unchanged; malicious source part rejected with the error envelope

## 3. Backend export endpoint (app-source-export)

- [x] 3.1 Add a read-only handler resolving a registered app + its active build jobID, returning the current manifest + a gzipped tar of `sources/<jobID>/`
- [x] 3.2 Signal explicitly when the active build has no stored source (return manifest + no-source indicator, never a fake/empty source tar)
- [x] 3.3 Reject unknown/unregistered app ids with the standard error envelope
- [x] 3.4 Guarantee the handler is side-effect free
- [x] 3.5 Mount the route in `cmd/pocketknife/main.go`
- [x] 3.6 Tests: known id returns manifest+source matching the served runtime; sourceless app returns the no-source signal; unknown id errors; export does not alter `/ui` or API behavior
- [x] 3.7 Round-trip test: exported manifest + (rebuilt) source re-POSTed to `/deploy` under a new jobId is accepted as a redeploy and preserves data

## 4. Agent app-source fetch seam + submitter source

- [x] 4.1 Define an `AppSourceFetcher` interface in `agent/src/seams/` returning the fetched manifest + source (and a no-source signal) for an app id
- [x] 4.2 Implement the HTTP fetcher reading from the backend export endpoint at the configured base URL
- [x] 4.3 Wire selection in `seams/select.ts` using the same env switch as the submitter; default keeps the existing offline flow
- [x] 4.4 Extend `seams/submitter.ts` to also tar `src/` (excluding `node_modules`/`dist`) as the `source` part of the deploy
- [x] 4.5 Tests: HTTP fetcher parses a backend export (with and without source); default selection makes no network call; submitter includes a well-formed source part

## 5. CLI + orchestrator update mode

- [x] 5.1 Add an optional `--app <app_id>` flag to `agent/src/cli.ts`
- [x] 5.2 In the orchestrator, when an app id is given, fetch the app's source via the fetcher before planning; fail fast on an unknown app id
- [x] 5.3 Seed the planner's starting manifest with the fetched manifest (not a blank draft)
- [x] 5.4 When source is returned, pre-populate the build scratch dir with the fetched source + regenerated client; when no source, regenerate the frontend from the manifest
- [x] 5.5 Keep the no-`--app` path byte-for-byte unchanged (new-app flow, no fetch)

## 6. Preserve app id and stable ids through edits

- [x] 6.1 Update the planner's manifest skill/instructions to keep `app.id` and all stable ids on update — only rename/add/remove, never remint
- [x] 6.2 Add an orchestrator/submit-time guard that the outgoing `app.id` equals the fetched id (and surface when a previously-present stable id disappeared without an explicit removal)
- [x] 6.3 Confirm the builder's scratch-guard hook still confines all writes to the job scratch dir in update mode

## 7. End-to-end + docs

- [ ] 7.1 E2E: fetch an existing app, rename a field + add a field via the planner, redeploy, assert data preserved and the rename moved no data
- [ ] 7.2 E2E: an edited frontend change (starting from fetched source) is activated and served at `/ui/<app_id>/`, and the edited source is stored for the next update
- [ ] 7.3 E2E: a legacy app with no stored source updates via manifest-driven regeneration
- [x] 7.4 Update `agent/FLOW.md` and `CLAUDE.md` to document update mode, the source store, and the export seam
- [x] 7.5 `make test` and `make vet` pass; agent test suite passes
