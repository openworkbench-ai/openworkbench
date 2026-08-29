package registry_test

import (
	"os"
	"path/filepath"
	"testing"

	"pocketknife/materialize"
	"pocketknife/registry"
	"pocketknife/schema"
	"pocketknife/store"
	"pocketknife/validate"
)

func writeManifest(t *testing.T, root, appID, body string) {
	t.Helper()
	dir := filepath.Join(root, appID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const readingManifest = `{
  "app": { "id": "reading_tracker", "name": "Reading Tracker", "version": 1 },
  "entities": [
    { "id": "ent_book", "name": "book", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true, "max": 200 }
    ]}
  ]
}`

const tasksManifest = `{
  "app": { "id": "tasks", "name": "Tasks", "version": 1 },
  "entities": [
    { "id": "ent_project", "name": "project", "fields": [
      { "id": "fld_name", "name": "name", "type": "text", "required": true, "unique": true }
    ]}
  ]
}`

// insertRow is a tiny direct-store helper for the runtime tests.
func insertRow(t *testing.T, ra *registry.RegisteredApp, entity string, values map[string]any) string {
	t.Helper()
	ent := ra.Schema.Entity(entity)
	values["id"] = store.NewID()
	now := store.NowUTC()
	values["created_at"] = now
	values["updated_at"] = now
	row, err := ra.Store.Insert(ent, values)
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	return row["id"].(string)
}

func TestRestartPersistsDataAndRederivesRegistry(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "reading_tracker", readingManifest)
	writeManifest(t, root, "tasks", tasksManifest)

	// First boot: register and write a row.
	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatalf("first boot: %v", err)
	}
	for _, r := range results {
		if !r.OK {
			t.Fatalf("app %s did not load: %v %v", r.ManifestPath, r.Errors, r.Err)
		}
	}
	ra, ok := reg.App("reading_tracker")
	if !ok {
		t.Fatal("reading_tracker not registered")
	}
	bookID := insertRow(t, ra, "book", map[string]any{"title": "Persisted"})
	reg.Close()

	// Simulated restart: delete the in-memory registry entirely and re-derive
	// from the same on-disk manifests + data.db files.
	reg2, _, err := registry.Load(root, root)
	if err != nil {
		t.Fatalf("second boot: %v", err)
	}
	defer reg2.Close()

	if _, ok := reg2.App("reading_tracker"); !ok {
		t.Fatal("registry did not re-derive reading_tracker from disk")
	}
	if _, ok := reg2.App("tasks"); !ok {
		t.Fatal("registry did not re-derive tasks from disk")
	}

	ra2, _ := reg2.App("reading_tracker")
	row, err := ra2.Store.GetByID(ra2.Schema.Entity("book"), bookID)
	if err != nil {
		t.Fatalf("get after restart: %v", err)
	}
	if row == nil || row["title"] != "Persisted" {
		t.Fatalf("data did not persist across restart: %v", row)
	}
}

func TestAppsHavePhysicallySeparateDatabases(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "reading_tracker", readingManifest)
	writeManifest(t, root, "tasks", tasksManifest)

	reg, _, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()

	reading, _ := reg.App("reading_tracker")
	tasks, _ := reg.App("tasks")

	if reading.Store.Path() == tasks.Store.Path() {
		t.Fatal("apps share a database file")
	}
	for _, p := range []string{reading.Store.Path(), tasks.Store.Path()} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("expected db file %s to exist: %v", p, err)
		}
	}
	if filepath.Dir(reading.Store.Path()) == filepath.Dir(tasks.Store.Path()) {
		t.Fatal("apps' databases live in the same directory")
	}
}

func TestBootIsIdempotentOnUnchangedManifests(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "reading_tracker", readingManifest)

	reg, _, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	ra, _ := reg.App("reading_tracker")
	bookID := insertRow(t, ra, "book", map[string]any{"title": "Once"})
	reg.Close()

	// Re-boot on the unchanged manifest: must not error and must not disturb data.
	reg2, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatalf("re-boot: %v", err)
	}
	for _, r := range results {
		if !r.OK {
			t.Fatalf("re-boot app %s failed: %v %v", r.ManifestPath, r.Errors, r.Err)
		}
	}
	defer reg2.Close()

	ra2, _ := reg2.App("reading_tracker")
	rows, total, err := ra2.Store.List(ra2.Schema.Entity("book"), store.ListQuery{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(rows) != 1 || rows[0]["id"] != bookID {
		t.Fatalf("idempotent re-boot changed data: total=%d rows=%v", total, rows)
	}
}

// TestManifestDatabaseMismatchIsSkippedNotServed proves the boot-time
// consistency check: if manifest.json is changed to add a field without ever
// running a migration against the app's data.db (registry.Load never
// migrates on an app's behalf — that's the CLI's/build's job), the app is
// refused with a clear diagnostic and skipped, rather than silently served
// against a database that no longer matches its schema. A sibling app must
// still boot normally.
func TestManifestDatabaseMismatchIsSkippedNotServed(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "reading_tracker", readingManifest)
	writeManifest(t, root, "tasks", tasksManifest)

	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		if !r.OK {
			t.Fatalf("initial boot: app %s failed: %v %v", r.ManifestPath, r.Errors, r.Err)
		}
	}
	reg.Close()

	// Hand-edit reading_tracker's manifest to add a field, without running a
	// migration — the exact scenario the check exists to catch.
	const mismatched = `{
      "app": { "id": "reading_tracker", "name": "Reading Tracker", "version": 2 },
      "entities": [
        { "id": "ent_book", "name": "book", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true, "max": 200 },
          { "id": "fld_author", "name": "author", "type": "text" }
        ]}
      ]
    }`
	writeManifest(t, root, "reading_tracker", mismatched)

	reg2, results2, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reg2.Close()

	var mismatchResult *registry.LoadResult
	for i := range results2 {
		if filepath.Base(filepath.Dir(results2[i].ManifestPath)) == "reading_tracker" {
			mismatchResult = &results2[i]
		}
	}
	if mismatchResult == nil || mismatchResult.OK {
		t.Fatal("a manifest/database mismatch must not boot OK")
	}
	if mismatchResult.Err == nil {
		t.Fatal("expected a clear diagnostic error for the mismatch")
	}
	if _, ok := reg2.App("reading_tracker"); ok {
		t.Fatal("a mismatched app must never be registered/served")
	}
	if _, ok := reg2.App("tasks"); !ok {
		t.Fatal("a sibling mismatched app must not stop an unaffected one from booting")
	}
}

// TestFreshAppAdoptsSchemaFingerprintOnFirstBoot proves a brand-new app gets
// its schema fingerprint recorded on its very first boot.
func TestFreshAppAdoptsSchemaFingerprintOnFirstBoot(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "reading_tracker", readingManifest)

	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	for _, r := range results {
		if !r.OK {
			t.Fatalf("boot: %v %v", r.Errors, r.Err)
		}
	}

	ra, _ := reg.App("reading_tracker")
	fp, ok, err := ra.Store.AppliedFingerprint()
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("a freshly booted app must have its schema fingerprint recorded")
	}
	if want := schema.Fingerprint(ra.Schema); fp != want {
		t.Fatalf("recorded fingerprint = %s, want %s", fp, want)
	}
}

// TestConstraintOnlyMismatchIsCaughtByFingerprintNotColumnCheck proves the
// fingerprint mechanism catches a constraint-only change (same columns,
// different semantics) that Store.VerifySchema's column-name check alone
// cannot see — the exact gap TestVerifySchemaDoesNotDetect* in store/
// characterizes.
func TestConstraintOnlyMismatchIsCaughtByFingerprintNotColumnCheck(t *testing.T) {
	root := t.TempDir()
	const v1 = `{
      "app": { "id": "notes", "name": "Notes", "version": 1 },
      "entities": [{ "id": "ent_note", "name": "note", "fields": [
        { "id": "fld_title", "name": "title", "type": "text" }
      ]}]
    }`
	writeManifest(t, root, "notes", v1)

	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		if !r.OK {
			t.Fatalf("initial boot: %v %v", r.Errors, r.Err)
		}
	}
	reg.Close()

	// Hand-edit: same field, same physical column, now required — a pure
	// constraint change with no column-level footprint at all.
	const v1Required = `{
      "app": { "id": "notes", "name": "Notes", "version": 1 },
      "entities": [{ "id": "ent_note", "name": "note", "fields": [
        { "id": "fld_title", "name": "title", "type": "text", "required": true }
      ]}]
    }`
	writeManifest(t, root, "notes", v1Required)

	reg2, results2, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reg2.Close()

	var res *registry.LoadResult
	for i := range results2 {
		if filepath.Base(filepath.Dir(results2[i].ManifestPath)) == "notes" {
			res = &results2[i]
		}
	}
	if res == nil || res.OK {
		t.Fatal("a constraint-only mismatch must not boot OK")
	}
	if res.Err == nil {
		t.Fatal("expected a clear diagnostic error for the fingerprint mismatch")
	}
	if _, ok := reg2.App("notes"); ok {
		t.Fatal("a fingerprint-mismatched app must never be registered/served")
	}
}

// materializeLegacyApp builds an app's manifest.json + data.db directly via
// materialize/store, bypassing registry.Load and build.Bootstrap entirely —
// simulating a database that predates the schema-fingerprint mechanism
// (never had SetAppliedFingerprint called against it).
func materializeLegacyApp(t *testing.T, root, appID, manifestJSON string) {
	t.Helper()
	dir := filepath.Join(root, appID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifestJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	app, verrs := validate.Manifest([]byte(manifestJSON))
	if len(verrs) > 0 {
		t.Fatalf("manifest invalid: %v", verrs)
	}
	stmts, err := materialize.Statements(app)
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.ApplyDDL(stmts); err != nil {
		t.Fatal(err)
	}
	// Deliberately no SetAppliedFingerprint call.
}

// TestLegacyAppWithoutFingerprintAdoptsBaselineWhenStructurallyConsistent
// documents the safe legacy path: a database that predates the fingerprint
// mechanism, but is genuinely structurally consistent with its manifest,
// boots successfully and adopts the manifest's fingerprint as its baseline.
func TestLegacyAppWithoutFingerprintAdoptsBaselineWhenStructurallyConsistent(t *testing.T) {
	root := t.TempDir()
	const v1 = `{
      "app": { "id": "legacy", "name": "Legacy", "version": 1 },
      "entities": [{ "id": "ent_x", "name": "x", "fields": [
        { "id": "fld_y", "name": "y", "type": "text" }
      ]}]
    }`
	materializeLegacyApp(t, root, "legacy", v1)

	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	for _, r := range results {
		if !r.OK {
			t.Fatalf("legacy app failed to adopt the fingerprint baseline: %v %v", r.Errors, r.Err)
		}
	}

	ra, ok := reg.App("legacy")
	if !ok {
		t.Fatal("a structurally-consistent legacy app must be registered")
	}
	fp, hasFP, err := ra.Store.AppliedFingerprint()
	if err != nil {
		t.Fatal(err)
	}
	if !hasFP || fp != schema.Fingerprint(ra.Schema) {
		t.Fatal("legacy app must have adopted the manifest's fingerprint as its baseline on this boot")
	}
}

// TestLegacyAppAlreadyMismatchedAdoptsOnceThenDetectsFurtherDrift documents
// the accepted, one-time limitation of adopting the fingerprint mechanism
// after the fact: a legacy database that was already constraint-mismatched
// relative to its manifest (same columns, different semantics — invisible
// to VerifySchema) boots and adopts that mismatched manifest's fingerprint
// as its baseline, since nothing before this point could have proven
// otherwise. Any *further* drift from that point on, however, is caught
// exactly like a fully up-to-date app's would be.
func TestLegacyAppAlreadyMismatchedAdoptsOnceThenDetectsFurtherDrift(t *testing.T) {
	root := t.TempDir()
	// Materialize with the field optional...
	const materializedAsOptional = `{
      "app": { "id": "legacy", "name": "Legacy", "version": 1 },
      "entities": [{ "id": "ent_x", "name": "x", "fields": [
        { "id": "fld_y", "name": "y", "type": "text" }
      ]}]
    }`
	materializeLegacyApp(t, root, "legacy", materializedAsOptional)

	// ...but the manifest on disk already (before this mechanism ever ran)
	// claims the field is required — a pre-existing, undetectable-at-this-
	// point mismatch.
	const manifestClaimsRequired = `{
      "app": { "id": "legacy", "name": "Legacy", "version": 1 },
      "entities": [{ "id": "ent_x", "name": "x", "fields": [
        { "id": "fld_y", "name": "y", "type": "text", "required": true }
      ]}]
    }`
	writeManifest(t, root, "legacy", manifestClaimsRequired)

	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		if !r.OK {
			t.Fatalf("expected the pre-existing mismatch to be silently adopted on first upgrade, got: %v %v", r.Errors, r.Err)
		}
	}
	reg.Close()

	// From here on, the mismatched manifest IS the recorded baseline. Any
	// further hand-edit must be caught normally.
	const furtherDrift = `{
      "app": { "id": "legacy", "name": "Legacy", "version": 1 },
      "entities": [{ "id": "ent_x", "name": "x", "fields": [
        { "id": "fld_y", "name": "y", "type": "text", "required": true, "unique": true }
      ]}]
    }`
	writeManifest(t, root, "legacy", furtherDrift)

	reg2, results2, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reg2.Close()
	for _, r := range results2 {
		if r.OK {
			t.Fatal("further drift past the adopted baseline must be detected and refused")
		}
	}
	if _, ok := reg2.App("legacy"); ok {
		t.Fatal("an app with further undetected drift must never be registered/served")
	}
}

func TestInvalidManifestIsSkippedNotServed(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "good", readingManifest)
	// declares a reserved field name -> must fail validation and be skipped.
	writeManifest(t, root, "bad", `{
      "app": { "id": "bad", "name": "Bad", "version": 1 },
      "entities": [ { "id": "ent_x", "name": "x", "fields": [
        { "id": "fld_id", "name": "id", "type": "text" }
      ]}]
    }`)

	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()

	var badResult *registry.LoadResult
	for i := range results {
		if filepath.Base(filepath.Dir(results[i].ManifestPath)) == "bad" {
			badResult = &results[i]
		}
	}
	if badResult == nil || badResult.OK {
		t.Fatal("invalid manifest was not reported as failed")
	}
	if len(badResult.Errors) == 0 {
		t.Fatal("expected structured validation errors for invalid manifest")
	}
	if _, ok := reg.App("bad"); ok {
		t.Fatal("invalid app must never be registered/served")
	}
	if _, ok := reg.App("reading_tracker"); !ok {
		t.Fatal("a sibling invalid manifest must not stop a valid one")
	}
}
