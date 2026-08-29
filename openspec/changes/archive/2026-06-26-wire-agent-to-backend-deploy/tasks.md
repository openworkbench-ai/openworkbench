## 1. Backend: bundle intake & containment

- [x] 1.1 Add a tar-extraction helper that streams the gzipped `bundle` part into a target dir, rejecting entries with `..`, absolute paths, or symlinks, and enforcing total-bytes and entry-count caps.
- [x] 1.2 Add a multipart request parser that reads the `jobId` field, the `manifest` part, and the `bundle` part, returning a typed struct and the standard error envelope on any missing/oversized part.
- [x] 1.3 Unit-test extraction containment (path-traversal entry, absolute path, symlink, oversize) and multipart parsing (missing parts).

## 2. Backend: first-install path

- [x] 2.1 Add a helper that bootstraps a brand-new app for an id not in the registry: create `apps/<app_id>/` (staged under a temp name), write `manifest.json` and the extracted bundle to `dist/`, `store.Open` the db, materialize DDL, and `registry.Register` — mirroring one app's slice of `registry.Load`.
- [x] 2.2 Ensure the stored manifest carries a `frontend` pointer (`{dist:"dist", entry:"index.html"}`) when the submitted manifest omits one; honor an explicit `frontend` block if present.
- [x] 2.3 Activate the frontend for the new app through the install path (build artifact dir + promote active) so it is served at `/ui/<app_id>/`.
- [x] 2.4 On any failure during 2.1–2.3, remove the staged app dir and leave the registry untouched; never register before store+materialize succeed.
- [x] 2.5 Test: a new app id becomes reachable at `/ui/<app_id>/` and its `/apps/<app_id>/...` API works against a fresh db; a forced failure leaves no registered app and no served dir.

## 3. Backend: deploy endpoint & redeploy routing

- [x] 3.1 Validate the manifest with `validate.Manifest` before any disk write; return the error list in the envelope on failure with no side effects.
- [x] 3.2 Route a known app id through `build.Deploy` (write new bundle to `dist/`, pass new manifest bytes) so install-vs-migration and the rollback contract are reused; route an unknown id through the first-install path.
- [x] 3.3 Make the endpoint idempotent on `jobId`: a `jobId` that already produced a ready/activated build returns that result without re-deploying (look up via the platform db).
- [x] 3.4 Serialize concurrent deploys per app id (reject or queue an in-flight job for the same app).
- [x] 3.5 Return `200 {appId, version, jobId, url}` on success; reuse the existing error envelope for all failures.
- [x] 3.6 Mount `POST /deploy` in `cmd/pocketknife/main.go` alongside the existing routes.
- [x] 3.7 Tests: valid first-install, valid redeploy preserving data, redeploy failure rollback, idempotent retry, invalid-manifest rejection.

## 4. Agent: HttpSubmitter over the seam

- [x] 4.1 Implement `HttpSubmitter.submit()` in `agent/src/seams/submitter.ts`: gzip-tar the scratch `dist/`, POST multipart (`jobId`, `manifest`, `bundle`) to `GO_BASE_URL/deploy`, parse the response, return `{appId}`; surface backend error envelopes as thrown errors.
- [x] 4.2 Confirm `seams/select.ts` needs no change (it already wires `SUBMIT_MODE=http` → `HttpSubmitter(goBaseUrl())`); keep `stub` as default.
- [x] 4.3 Update `submitter.test.ts` to cover the HTTP path against a mock server (success returns appId; backend error throws).
- [x] 4.4 Document `SUBMIT_MODE=http` and `GO_BASE_URL` in `agent/.env.example`; update `agent/FLOW.md`'s "stub today, real Go backend later" section to mark the submit seam implemented.

## 5. End-to-end verification & docs

- [x] 5.1 Run an end-to-end check: agent (`SUBMIT_MODE=http`) plans → builds → submits to a running server; confirm the app is reachable at `/ui/<app_id>/` and its API responds — extend or add to `test_project_hub.sh` if practical.
- [x] 5.2 Update `README.md`/`CLAUDE.md` to note the `/deploy` ingest route and the agent→backend deploy flow.
- [x] 5.3 `make test`, `make vet`, `make fmt` clean; agent `npm test` passes.
