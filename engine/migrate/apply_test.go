package migrate

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"pocketknife/registry"
	"pocketknife/schema"
	"pocketknife/store"
)

// setupReg writes a manifest to a temp apps dir and boots a registry over it.
func setupReg(t *testing.T, appID, manifest string) (*registry.Registry, string) {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, appID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatalf("boot: %v", err)
	}
	for _, r := range results {
		if !r.OK {
			t.Fatalf("app failed to load: %v %v", r.Errors, r.Err)
		}
	}
	t.Cleanup(func() { reg.Close() })
	return reg, dir
}

func seedReg(t *testing.T, reg *registry.Registry, appID, entity string, values map[string]any) string {
	t.Helper()
	ra, _ := reg.App(appID)
	return seed(t, ra.Store, ra.Schema.Entity(entity), values)
}

const applyV1 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 1 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true },
      { "id": "fld_count", "name": "count", "type": "integer" }
    ]}
  ]
}`

func TestApplySafeAutoApplies(t *testing.T) {
	reg, dir := setupReg(t, "tracker", applyV1)
	id := seedReg(t, reg, "tracker", "item", map[string]any{"title": "keep", "count": int64(1)})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" },
          { "id": "fld_note", "name": "note", "type": "text" }
        ]}
      ]
    }`
	// No confirmation needed for a purely safe migration.
	res, err := Apply(context.Background(), reg, "tracker", []byte(v2), Options{})
	if err != nil {
		t.Fatalf("safe apply: %v", err)
	}
	if res.NoChange || res.SnapshotPath != "" {
		t.Fatalf("safe migration should change schema and take no snapshot: %+v", res)
	}

	// The registry now serves the new schema, and data is intact.
	ra, _ := reg.App("tracker")
	if ra.Schema.Version != 2 || ra.Schema.Entity("item").Field("note") == nil {
		t.Fatal("registry not updated to the new schema")
	}
	row, _ := ra.Store.GetByID(ra.Schema.Entity("item"), id)
	if row["title"] != "keep" || row["note"] != nil {
		t.Fatalf("data not preserved through safe apply: %v", row)
	}
	// manifest.json was promoted on disk.
	onDisk, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if string(onDisk) != v2 {
		t.Fatal("manifest.json was not promoted to the new version")
	}
}

func TestApplyDestructiveRefusedWithoutConfirm(t *testing.T) {
	reg, dir := setupReg(t, "tracker", applyV1)
	id := seedReg(t, reg, "tracker", "item", map[string]any{"title": "keep", "count": int64(7)})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true }
        ]}
      ]
    }`
	res, err := Apply(context.Background(), reg, "tracker", []byte(v2), Options{Confirm: false})
	if err == nil {
		t.Fatal("dropping a field without confirmation must be refused")
	}
	// Nothing changed: schema, data, and manifest are untouched.
	ra, _ := reg.App("tracker")
	if ra.Schema.Version != 1 || ra.Schema.Entity("item").Field("count") == nil {
		t.Fatal("refused migration must leave the prior schema registered")
	}
	row, _ := ra.Store.GetByID(ra.Schema.Entity("item"), id)
	if row == nil || row["count"] == nil {
		t.Fatalf("refused migration must not touch data: %v", row)
	}
	if onDisk, _ := os.ReadFile(filepath.Join(dir, "manifest.json")); string(onDisk) != applyV1 {
		t.Fatal("refused migration must not promote the manifest")
	}
	_ = res
}

func TestApplyDestructiveWithConfirmTakesSnapshot(t *testing.T) {
	reg, _ := setupReg(t, "tracker", applyV1)
	id := seedReg(t, reg, "tracker", "item", map[string]any{"title": "keep", "count": int64(7)})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true }
        ]}
      ]
    }`
	res, err := Apply(context.Background(), reg, "tracker", []byte(v2), Options{Confirm: true})
	if err != nil {
		t.Fatalf("confirmed destructive apply: %v", err)
	}
	if res.SnapshotPath == "" {
		t.Fatal("a destructive migration must take a snapshot")
	}
	if _, err := os.Stat(res.SnapshotPath); err != nil {
		t.Fatalf("snapshot file missing: %v", err)
	}
	ra, _ := reg.App("tracker")
	if ra.Schema.Entity("item").Field("count") != nil {
		t.Fatal("dropped field still present after confirmed migration")
	}
	row, _ := ra.Store.GetByID(ra.Schema.Entity("item"), id)
	if row["title"] != "keep" {
		t.Fatalf("surviving data lost: %v", row)
	}
}

// TestApplyRestoresOnExecutionFailure forces a failure that passes pre-flight but
// fails during execution (adding a uniqueness constraint over duplicate rows) and
// proves the snapshot restores the data and the prior schema stays registered.
func TestApplyRestoresOnExecutionFailure(t *testing.T) {
	const v1 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 1 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_code", "name": "code", "type": "text", "required": true }
        ]}
      ]
    }`
	reg, dir := setupReg(t, "tracker", v1)
	// Two rows sharing a code: a later UNIQUE index cannot be built.
	seedReg(t, reg, "tracker", "item", map[string]any{"code": "dup"})
	seedReg(t, reg, "tracker", "item", map[string]any{"code": "dup"})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_code", "name": "code", "type": "text", "required": true, "unique": true }
        ]}
      ]
    }`
	res, err := Apply(context.Background(), reg, "tracker", []byte(v2), Options{Confirm: true})
	if err == nil {
		t.Fatal("adding a unique constraint over duplicates must fail")
	}
	_ = res

	// Prior schema is still registered (no uniqueness), and both rows survive.
	ra, _ := reg.App("tracker")
	if ra.Schema.Version != 1 || ra.Schema.Entity("item").Field("code").Unique {
		t.Fatal("failed migration must keep the prior (non-unique) schema")
	}
	_, total, err := ra.Store.List(ra.Schema.Entity("item"), store.ListQuery{Limit: 100})
	if err != nil {
		t.Fatalf("list after restore: %v", err)
	}
	if total != 2 {
		t.Fatalf("restore lost data: %d rows, want 2", total)
	}
	if onDisk, _ := os.ReadFile(filepath.Join(dir, "manifest.json")); string(onDisk) != v1 {
		t.Fatal("failed migration must not promote the manifest")
	}
}

// TestApplyRequiredFieldWithBackfillWitnessEndToEnd exercises the one witness
// shape not otherwise covered at the Apply level: adding a required field
// with no default over existing rows, supplying a WitnessBackfill, and
// verifying every pre-existing row ends up holding the exact backfilled
// value after Apply succeeds.
func TestApplyRequiredFieldWithBackfillWitnessEndToEnd(t *testing.T) {
	reg, _ := setupReg(t, "tracker", applyV1)
	id1 := seedReg(t, reg, "tracker", "item", map[string]any{"title": "keep one", "count": int64(1)})
	id2 := seedReg(t, reg, "tracker", "item", map[string]any{"title": "keep two", "count": int64(2)})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" },
          { "id": "fld_category", "name": "category", "type": "text", "required": true }
        ]}
      ]
    }`

	// Without a witness, a required-with-no-default add is refused even with
	// -confirm.
	if _, err := Apply(context.Background(), reg, "tracker", []byte(v2), Options{Confirm: true}); err == nil {
		t.Fatal("adding a required field with no default and no witness must be refused")
	}
	ra, _ := reg.App("tracker")
	if ra.Schema.Version != 1 {
		t.Fatal("refused migration must leave the prior schema registered")
	}

	res, err := Apply(context.Background(), reg, "tracker", []byte(v2), Options{
		Confirm: true,
		Witnesses: map[string]*Witness{
			"fld_category": {Kind: WitnessBackfill, Backfill: "uncategorized"},
		},
	})
	if err != nil {
		t.Fatalf("apply with backfill witness: %v", err)
	}
	if res.NoChange {
		t.Fatal("adding a field is a real change")
	}

	ra, _ = reg.App("tracker")
	if ra.Schema.Version != 2 || ra.Schema.Entity("item").Field("category") == nil {
		t.Fatal("registry not updated to the new schema")
	}

	for _, id := range []string{id1, id2} {
		row, err := ra.Store.GetByID(ra.Schema.Entity("item"), id)
		if err != nil {
			t.Fatalf("read row %s: %v", id, err)
		}
		if row["category"] != "uncategorized" {
			t.Fatalf("row %s category = %v, want backfilled %q", id, row["category"], "uncategorized")
		}
		// The rest of the row survived untouched.
		if row["title"] == nil {
			t.Fatalf("row %s lost its title across the migration: %v", id, row)
		}
	}
}

// TestVerifySchemaMatchesAfterEveryMigrationShape is the load-bearing check
// behind store.VerifySchema's exact-match design (boot-time manifest/database
// consistency, see registry.Load): it drives an app through a rename, a safe
// add, a destructive add-with-backfill, and a destructive drop — the native
// ADD/DROP path and the table-rebuild path both — and asserts VerifySchema
// reports no mismatch after each, on the exact schema Apply leaves registered.
// A false positive here would mean materialize's and migrate's column
// conventions have diverged, which is exactly the class of bug this test
// exists to catch before VerifySchema's boot-time hard-fail is trusted.
func TestVerifySchemaMatchesAfterEveryMigrationShape(t *testing.T) {
	reg, _ := setupReg(t, "tracker", applyV1)
	seedReg(t, reg, "tracker", "item", map[string]any{"title": "keep", "count": int64(1)})

	verify := func(t *testing.T) {
		t.Helper()
		ra, _ := reg.App("tracker")
		if err := ra.Store.VerifySchema(ra.Schema); err != nil {
			t.Fatalf("VerifySchema false positive after migration: %v", err)
		}
	}
	verify(t) // fresh materialize, before any migration

	// Rename (title -> heading): zero SQL, but must still verify.
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "heading", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" }
        ]}
      ]
    }`
	if _, err := Apply(context.Background(), reg, "tracker", []byte(v2), Options{}); err != nil {
		t.Fatalf("rename apply: %v", err)
	}
	verify(t)

	// Safe add (native ALTER TABLE ADD COLUMN).
	const v3 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 3 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "heading", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" },
          { "id": "fld_note", "name": "note", "type": "text" }
        ]}
      ]
    }`
	if _, err := Apply(context.Background(), reg, "tracker", []byte(v3), Options{}); err != nil {
		t.Fatalf("safe add apply: %v", err)
	}
	verify(t)

	// Destructive add with a backfill witness (table rebuild).
	const v4 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 4 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "heading", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" },
          { "id": "fld_note", "name": "note", "type": "text" },
          { "id": "fld_category", "name": "category", "type": "text", "required": true }
        ]}
      ]
    }`
	if _, err := Apply(context.Background(), reg, "tracker", []byte(v4), Options{
		Confirm:   true,
		Witnesses: map[string]*Witness{"fld_category": {Kind: WitnessBackfill, Backfill: "none"}},
	}); err != nil {
		t.Fatalf("backfill apply: %v", err)
	}
	verify(t)

	// Destructive drop (native ALTER TABLE DROP COLUMN).
	const v5 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 5 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "heading", "type": "text", "required": true },
          { "id": "fld_category", "name": "category", "type": "text", "required": true }
        ]}
      ]
    }`
	if _, err := Apply(context.Background(), reg, "tracker", []byte(v5), Options{Confirm: true}); err != nil {
		t.Fatalf("drop apply: %v", err)
	}
	verify(t)
}

// TestApplySafeMigrationAdvancesSchemaFingerprint proves a successful
// migration's schema fingerprint is updated atomically with the schema
// change itself (migrate/execute.go's store.WriteAppliedFingerprintTx, run
// inside the same transaction as the DDL/DML).
func TestApplySafeMigrationAdvancesSchemaFingerprint(t *testing.T) {
	reg, _ := setupReg(t, "tracker", applyV1)
	ra, _ := reg.App("tracker")

	before, ok, err := ra.Store.AppliedFingerprint()
	if err != nil || !ok {
		t.Fatalf("expected a baseline fingerprint from boot, got ok=%v err=%v", ok, err)
	}
	if before != schema.Fingerprint(ra.Schema) {
		t.Fatal("baseline fingerprint does not match the booted schema")
	}

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" },
          { "id": "fld_note", "name": "note", "type": "text" }
        ]}
      ]
    }`
	if _, err := Apply(context.Background(), reg, "tracker", []byte(v2), Options{}); err != nil {
		t.Fatalf("apply: %v", err)
	}

	ra, _ = reg.App("tracker")
	after, ok, err := ra.Store.AppliedFingerprint()
	if err != nil || !ok {
		t.Fatalf("expected an updated fingerprint after migration, got ok=%v err=%v", ok, err)
	}
	if after == before {
		t.Fatal("fingerprint did not change after a schema-changing migration")
	}
	if after != schema.Fingerprint(ra.Schema) {
		t.Fatal("recorded fingerprint does not match the newly migrated schema")
	}
}

// TestApplyRenameOnlyMigrationLeavesFingerprintUnchanged proves a pure
// rename — classified safe, and executed with zero SQL — correctly leaves
// the fingerprint's value unchanged, since schema.Fingerprint excludes Name
// by design: a rename is not a schema-relevant change.
func TestApplyRenameOnlyMigrationLeavesFingerprintUnchanged(t *testing.T) {
	reg, _ := setupReg(t, "tracker", applyV1)
	ra, _ := reg.App("tracker")
	before, _, _ := ra.Store.AppliedFingerprint()

	const renamed = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "renamed_item", "fields": [
          { "id": "fld_title", "name": "renamed_title", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" }
        ]}
      ]
    }`
	if _, err := Apply(context.Background(), reg, "tracker", []byte(renamed), Options{}); err != nil {
		t.Fatalf("apply: %v", err)
	}

	ra, _ = reg.App("tracker")
	after, ok, err := ra.Store.AppliedFingerprint()
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if after != before {
		t.Fatal("a pure rename must not change the recorded fingerprint")
	}
	if after != schema.Fingerprint(ra.Schema) {
		t.Fatal("recorded fingerprint must still match the (renamed) schema")
	}
}

// TestApplyFailedMigrationLeavesFingerprintAtPriorValue proves the
// fingerprint only ever moves forward on success: a migration whose
// execution fails and is restored from snapshot must leave the fingerprint
// exactly where it was (restored as part of the same byte-for-byte snapshot
// restore that reverts the data, since the fingerprint lives inside the
// same data.db file).
func TestApplyFailedMigrationLeavesFingerprintAtPriorValue(t *testing.T) {
	const v1 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 1 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_code", "name": "code", "type": "text", "required": true }
        ]}
      ]
    }`
	reg, _ := setupReg(t, "tracker", v1)
	seedReg(t, reg, "tracker", "item", map[string]any{"code": "dup"})
	seedReg(t, reg, "tracker", "item", map[string]any{"code": "dup"})

	ra, _ := reg.App("tracker")
	before, _, _ := ra.Store.AppliedFingerprint()

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_code", "name": "code", "type": "text", "required": true, "unique": true }
        ]}
      ]
    }`
	if _, err := Apply(context.Background(), reg, "tracker", []byte(v2), Options{Confirm: true}); err == nil {
		t.Fatal("adding a unique constraint over duplicates must fail")
	}

	ra, _ = reg.App("tracker")
	after, ok, err := ra.Store.AppliedFingerprint()
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if after != before {
		t.Fatal("a failed, restored migration must leave the fingerprint at its prior value")
	}
	if after != schema.Fingerprint(ra.Schema) {
		t.Fatal("fingerprint must still match the restored (unchanged) schema")
	}
}

func TestApplyNoChange(t *testing.T) {
	reg, _ := setupReg(t, "tracker", applyV1)
	res, err := Apply(context.Background(), reg, "tracker", []byte(applyV1), Options{})
	if err != nil {
		t.Fatalf("no-op apply: %v", err)
	}
	if !res.NoChange {
		t.Fatal("identical manifest should report NoChange")
	}
}
