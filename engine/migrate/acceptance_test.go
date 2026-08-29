package migrate

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"pocketknife/schema"
	"pocketknife/store"
)

// This file is the engine's acceptance suite: the real proof from the build
// prompt's §5 table. The remaining rows are proven by sibling tests:
//   - add nullable field        → TestExecuteAddNullableField
//   - add entity + a reference  → TestExecuteAddEntityWithReference
//   - widen a type (int→real)   → TestExecuteWidenIntegerToReal
//   - drop a field (gated)      → TestApplyDestructiveRefusedWithoutConfirm / WithConfirm
//   - narrow with a witness     → TestNarrowWithCoerceTruncate
//   - nullable→not-null         → TestNullableToNotNullRequiresBackfill
// Here we add the headline (rename runs zero SQL), the byte-exact undo, and the
// mis-annotation override.

// schemaVersion reads PRAGMA schema_version through a fresh connection. It changes
// only when the database schema changes, so it is a reliable witness that no DDL
// ran.
func schemaVersion(t *testing.T, dbPath string) int {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open raw: %v", err)
	}
	defer db.Close()
	var v int
	if err := db.QueryRow("PRAGMA schema_version;").Scan(&v); err != nil {
		t.Fatalf("schema_version: %v", err)
	}
	return v
}

// TestAcceptanceRenameRunsZeroSQL is the headline: renaming a field preserves all
// data and runs no SQL at all — the schema version is unchanged.
func TestAcceptanceRenameRunsZeroSQL(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "data.db")
	st, oldApp := openApp(t, dir, itemV1)
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "keep me", "count": int64(3)})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "headline", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" }
        ]}
      ]
    }`
	newApp := parseApp(t, v2)

	cs := Diff(oldApp, newApp)
	cs.Classify()
	for _, op := range cs.Ops {
		if op.Class != ClassSafe {
			t.Fatalf("rename should be safe, got %q for %s", op.Class, op.Kind)
		}
	}

	// Checkpoint so schema_version is observable from another connection, then
	// capture it on both sides of the migration.
	if err := st.Checkpoint(); err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	before := schemaVersion(t, dbPath)
	if err := Execute(context.Background(), st, oldApp, newApp, cs); err != nil {
		t.Fatalf("rename execute: %v", err)
	}
	if err := st.Checkpoint(); err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	after := schemaVersion(t, dbPath)
	if before != after {
		t.Fatalf("rename changed schema_version %d -> %d; expected zero SQL", before, after)
	}

	// Data survives and is readable under the new name.
	row, _ := st.GetByID(newApp.Entity("item"), id)
	if row["headline"] != "keep me" {
		t.Fatalf("data not preserved under renamed field: %v", row)
	}
	st.Close()
}

// TestAcceptanceUndoRestoresByteForByte proves a dropped field and its data come
// back byte-for-byte from the snapshot the destructive migration took.
func TestAcceptanceUndoRestoresByteForByte(t *testing.T) {
	reg, dir := setupReg(t, "tracker", applyV1)
	id := seedReg(t, reg, "tracker", "item", map[string]any{"title": "keep", "count": int64(42)})
	dbPath := filepath.Join(dir, "data.db")

	const dropCount = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true }
        ]}
      ]
    }`
	res, err := Apply(context.Background(), reg, "tracker", []byte(dropCount), Options{Confirm: true})
	if err != nil {
		t.Fatalf("drop apply: %v", err)
	}
	if res.SnapshotPath == "" {
		t.Fatal("destructive migration must snapshot")
	}
	snapBytes, _ := os.ReadFile(res.SnapshotPath)

	// The column is gone now.
	ra, _ := reg.App("tracker")
	if ra.Schema.Entity("item").Field("count") != nil {
		t.Fatal("count should be dropped")
	}

	// Undo: close, restore the snapshot, reopen.
	ra.Store.Close()
	if err := Restore(res.SnapshotPath, dbPath); err != nil {
		t.Fatalf("restore: %v", err)
	}
	// The restored file is byte-identical to the snapshot.
	restored, _ := os.ReadFile(dbPath)
	if !bytes.Equal(snapBytes, restored) {
		t.Fatal("undo is not byte-exact")
	}
	// And the column and its value are back.
	st, oldApp := reopenForRead(t, dbPath, applyV1)
	defer st.Close()
	row, _ := st.GetByID(oldApp.Entity("item"), id)
	if row == nil || row["count"] == nil {
		t.Fatalf("undo did not restore the dropped column/data: %v", row)
	}
	if got, ok := row["count"].(int64); !ok || got != 42 {
		t.Fatalf("undo restored wrong value: %v", row["count"])
	}
}

// reopenForRead opens an existing database for reading against a known schema.
func reopenForRead(t *testing.T, dbPath, manifest string) (*store.Store, *schema.App) {
	t.Helper()
	app := parseApp(t, manifest)
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	return st, app
}

// TestAcceptanceMisAnnotationOverridden proves a caller cannot relabel a
// destructive op as safe: the computed classification wins, and the apply flow
// (which derives its own changeset) still gates it.
func TestAcceptanceMisAnnotationOverridden(t *testing.T) {
	// At the operation level: a hostile annotation is ignored.
	op := Operation{
		Kind:        OpDropField,
		BeforeField: &schema.Field{ID: "fld_x", Name: "x", Type: schema.TypeText},
		Annotation:  ClassSafe,
	}
	if Classify(op) != ClassDestructive {
		t.Fatal("computed classification must override a 'safe' annotation")
	}

	// At the flow level: dropping a field is still gated behind confirmation,
	// regardless of any caller intent, because Apply computes the class itself.
	reg, _ := setupReg(t, "tracker", applyV1)
	const dropCount = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true }
        ]}
      ]
    }`
	if _, err := Apply(context.Background(), reg, "tracker", []byte(dropCount), Options{Confirm: false}); err == nil {
		t.Fatal("apply must gate the drop even if a caller would claim it safe")
	}
}
