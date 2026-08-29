# build-activation Specification

## Purpose

Turn a derived app's validated manifest and optional pre-built frontend bundle into an
openable app, and turn a new manifest version into one coherent "second deploy" — data
migration and frontend rebuild landed together with a single rollback contract — all
recorded as a legible, retriable history of build attempts in a platform-level database that
is independent of every app's own data, so a failed or interrupted build never costs a
running app its current, working version.

## Requirements

### Requirement: Build jobs are durable records of one attempt, in a platform database

The system SHALL persist every build attempt as a job row in a SQLite database separate from
any app's own `data.db`. Each job SHALL record its app id, kind (`install` or `deploy`),
target manifest version, current state, a diagnosable error message once failed, the asset
directory it produced (if any), and creation/update timestamps. Kind SHALL be derived by
comparing the incoming manifest's version against the app's currently-registered schema
version, never supplied by the caller.

#### Scenario: An install job targets the app's current version

- **WHEN** Deploy is called with a manifest whose version equals the app's currently
  registered schema version
- **THEN** the created job's kind is `install`

#### Scenario: A deploy job targets a new version

- **WHEN** Deploy is called with a manifest whose version differs from the app's currently
  registered schema version
- **THEN** the created job's kind is `deploy`

### Requirement: The build-job state machine enforces a fixed transition map

The system SHALL define exactly five states — `queued`, `building`, `activating`, `ready`,
`failed` — and SHALL only allow the transitions `queued → building`, `building →
activating`, `activating → ready`, and `failed` from each of `queued`, `building`, and
`activating`. `ready` and `failed` SHALL both be terminal: neither has any allowed outgoing
transition. An attempted transition outside this map SHALL be rejected and SHALL NOT alter
the job's persisted state.

#### Scenario: The happy path moves through every working state in order

- **WHEN** a build proceeds without error
- **THEN** its job is observed in `queued`, then `building`, then `activating`, then `ready`,
  in that order

#### Scenario: Failure is reachable from every working state

- **WHEN** a build fails while `queued`, `building`, or `activating`
- **THEN** the job transitions to `failed` and carries a non-empty error message

#### Scenario: A terminal job cannot be transitioned again

- **WHEN** a transition is attempted on a job already in `ready` or `failed`
- **THEN** the transition is rejected and the job's state is unchanged

#### Scenario: Retrying a failed build creates a new job, never reopens the old one

- **WHEN** Deploy is called again for an app whose most recent job is `failed`
- **THEN** a new job row is created in `queued`, and the failed job's row is left untouched as
  a permanent record of that attempt

### Requirement: A fresh install builds and activates a frontend without prior history

The system SHALL, given an app with no `frontend` block configured, build the declared
frontend bundle into a job-id-named directory and activate it as that app's currently-served
asset directory.

#### Scenario: A first build serves the real frontend

- **WHEN** Deploy runs for an app's current manifest version which declares a frontend
- **THEN** the job reaches `ready` and a request to that app's asset path is served from the
  newly built directory

### Requirement: A failed build leaves the job in a legible, diagnosable, retriable failed state

The system SHALL, when any build step fails, transition the job to `failed` with a
human-readable cause and SHALL leave any previously-active artifact for that app completely
untouched and still serving. The system SHALL allow a subsequent Deploy call for the same app
to proceed normally, independent of the failed job.

#### Scenario: A broken frontend build fails legibly without touching a prior artifact

- **WHEN** a frontend build step fails (e.g. a missing or unbuildable asset source)
- **THEN** the job transitions to `failed` carrying the underlying error, and an app that had
  no prior activation remains unactivated rather than partially activated

#### Scenario: Retrying after a failure succeeds independently

- **WHEN** Deploy is called again for the same app with a corrected manifest or frontend
  source after a prior failure
- **THEN** the new job can reach `ready` normally, regardless of the earlier job's `failed`
  state

### Requirement: Activation and re-activation never darken a running app

The system SHALL build every new artifact into its own immutable, job-id-named directory
under the app's `builds/` directory, never overwriting a previously-built directory. The
system SHALL only update the durable active-build pointer and the in-memory registry's asset
directory after the new artifact is fully written to disk, and SHALL update both together.
Until that point, every request SHALL continue to be served from the previous artifact.

#### Scenario: A second successful build replaces the served artifact atomically

- **WHEN** a second Deploy for an already-activated app completes successfully
- **THEN** requests made before the cutover are served by the old artifact and requests made
  after are served by the new one, with no point at which neither artifact is being served

#### Scenario: A failed rebuild leaves the previous version serving

- **WHEN** a rebuild of an already-activated app fails at any step
- **THEN** the app's active build pointer and asset directory remain unchanged, and the
  previously-active artifact continues to serve every request

### Requirement: A second deploy lands a data migration and a frontend rebuild as one operation

The system SHALL, for a deploy that changes the manifest version, perform an unconditional
data snapshot, then run the data migration, then build the new frontend (if declared), then
activate — in that fixed order — as a single operation with one rollback contract. SHALL a
failure occur at any point after the snapshot, the system SHALL roll back the data to the
pre-deploy snapshot, restore the on-disk manifest bytes to the prior version, and
re-register the prior schema, store, and asset directory together, leaving the app exactly as
openable as it was before the deploy was attempted.

#### Scenario: A migration and frontend rebuild both succeed

- **WHEN** a new manifest version with both a schema change and a frontend rebuild is
  deployed successfully
- **THEN** the app's data reflects the migration, the app serves the new frontend, and the
  on-disk manifest is now the new version

#### Scenario: A frontend build failure after a successful migration rolls back the migration too

- **WHEN** the data migration step succeeds but the subsequent frontend build step fails
- **THEN** the app's data, on-disk manifest, and served asset directory are all rolled back to
  their pre-deploy state, and the job is recorded as `failed`

#### Scenario: Data survives a rolled-back deploy

- **WHEN** a second deploy is rolled back
- **THEN** every record present before the deploy was attempted is still present afterward,
  unchanged

#### Scenario: A retried second deploy can succeed after a rollback

- **WHEN** Deploy is called again with a corrected manifest after a rolled-back deploy
- **THEN** the new job can complete normally and the app ends up on the new version

#### Scenario: Dropping the frontend block on a version bump is an intentional API-only transition

- **WHEN** a new manifest version removes its `frontend` block entirely
- **THEN** the deploy succeeds, the app's asset directory is cleared, and the app continues
  serving its API with no UI

### Requirement: Boot reconciliation resolves every in-flight job and prevents reboot darkout

On every process start, after the registry has been loaded (with every app's asset directory
starting empty), the system SHALL resolve every build job left in `queued`, `building`, or
`activating`: if that job's own activation had already durably committed, it SHALL be
completed retroactively to `ready`; otherwise it SHALL be transitioned to `failed` with a
fixed message indicating the build could not survive a process restart. The system SHALL then
re-validate every registered app's durable active-build pointer and reattach it to the
freshly-booted registry whenever its recorded manifest version matches the app's currently
registered schema version and its artifact still exists on disk.

#### Scenario: An interrupted job with no committed activation is failed

- **WHEN** a job is left `building` or `activating` at the moment of a process restart, and
  its app's durable active-build pointer does not point at that job
- **THEN** reconciliation transitions the job to `failed`

#### Scenario: A job whose activation committed just before the crash is completed, not failed

- **WHEN** a job's activation had already durably committed before the process died, even
  though the job's own state was never updated to `ready`
- **THEN** reconciliation transitions that job directly to `ready` rather than `failed`

#### Scenario: A reboot reattaches a previously-ready app without rebuilding anything

- **WHEN** the process restarts and an app's durable active-build pointer matches its
  currently registered schema version and its artifact still exists on disk
- **THEN** reconciliation reattaches that asset directory to the registry, and the app serves
  its frontend immediately with no rebuild

#### Scenario: A stale or missing pointer is reported broken and left unattached

- **WHEN** an app's durable active-build pointer's manifest version no longer matches its
  registered schema version, or its recorded artifact no longer exists on disk
- **THEN** reconciliation does not reattach that pointer and reports the app as broken, rather
  than serving a stale or nonexistent artifact

### Requirement: Build status is observable read-only over HTTP

The system SHALL expose `GET /builds/{app}` returning every build job for that app (most
recent first) plus its current active-build pointer (if any), and `GET /builds/job/{id}`
returning a single job by id. Both routes SHALL respond with the same error envelope shape as
the generic API. Neither route SHALL start, cancel, or stream a build.

#### Scenario: Listing builds for an unknown app is 404

- **WHEN** `GET /builds/{app}` is requested for an app id that is not registered
- **THEN** the response is 404 with the standard error envelope

#### Scenario: Fetching an unknown job id is 404

- **WHEN** `GET /builds/job/{id}` is requested for a job id that does not exist
- **THEN** the response is 404 with the standard error envelope

#### Scenario: A listed app's jobs are ordered most recent first

- **WHEN** `GET /builds/{app}` is requested for an app with multiple build jobs
- **THEN** the jobs array is ordered from most recent attempt to least recent
