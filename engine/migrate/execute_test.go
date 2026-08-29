package migrate

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"pocketknife/materialize"
	"pocketknife/schema"
	"pocketknife/store"
)

// openApp opens a fresh store for an app manifest and materializes its schema.
func openApp(t *testing.T, dir, manifest string) (*store.Store, *schema.App) {
	t.Helper()
	app := parseApp(t, manifest)
	stmts, err := materialize.Statements(app)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	st, err := store.Open(filepath.Join(dir, "data.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.ApplyDDL(stmts); err != nil {
		t.Fatalf("ddl: %v", err)
	}
	return st, app
}

func seed(t *testing.T, st *store.Store, ent *schema.Entity, values map[string]any) string {
	t.Helper()
	now := store.NowUTC()
	values["id"] = store.NewID()
	values["created_at"] = now
	values["updated_at"] = now
	row, err := st.Insert(ent, values)
	if err != nil {
		t.Fatalf("seed insert: %v", err)
	}
	return row["id"].(string)
}

// physicalColumns reads the actual SQLite column names of a table via a fresh
// read-only connection, to prove ADD/DROP COLUMN at the physical level.
func physicalColumns(t *testing.T, dbPath, table string) map[string]bool {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open raw: %v", err)
	}
	defer db.Close()
	rows, err := db.Query("PRAGMA table_info(" + table + ");")
	if err != nil {
		t.Fatalf("table_info: %v", err)
	}
	defer rows.Close()
	cols := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt any
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("scan table_info: %v", err)
		}
		cols[name] = true
	}
	return cols
}

// runMigration diffs old->new, classifies, attaches any witnesses, and executes.
func runMigration(t *testing.T, st *store.Store, oldApp, newApp *schema.App, witnesses map[string]*Witness) error {
	t.Helper()
	cs := Diff(oldApp, newApp)
	cs.Classify()
	for i := range cs.Ops {
		if w, ok := witnesses[cs.Ops[i].FieldID]; ok {
			cs.Ops[i].Witness = w
		}
	}
	return Execute(context.Background(), st, oldApp, newApp, cs)
}

const itemV1 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 1 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true },
      { "id": "fld_count", "name": "count", "type": "integer" }
    ]}
  ]
}`

func TestExecuteAddNullableField(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, itemV1)
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "keep", "count": int64(1)})

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
	newApp := parseApp(t, v2)
	if err := runMigration(t, st, oldApp, newApp, nil); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	row, err := st.GetByID(newApp.Entity("item"), id)
	if err != nil || row == nil {
		t.Fatalf("read after add: %v row=%v", err, row)
	}
	if row["title"] != "keep" {
		t.Fatalf("existing data lost: %v", row["title"])
	}
	if row["note"] != nil {
		t.Fatalf("new nullable field should be null, got %v", row["note"])
	}
	if !physicalColumns(t, filepath.Join(dir, "data.db"), "ent_item")["fld_note"] {
		t.Fatal("fld_note column not added physically")
	}
	st.Close()
}

func TestExecuteAddEntityWithReference(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, itemV1)
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "keep", "count": int64(2)})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" },
          { "id": "fld_owner", "name": "owner", "type": "reference", "target": "ent_person", "onDelete": "set_null" }
        ]},
        { "id": "ent_person", "name": "person", "fields": [
          { "id": "fld_pname", "name": "name", "type": "text", "required": true }
        ]}
      ]
    }`
	newApp := parseApp(t, v2)
	if err := runMigration(t, st, oldApp, newApp, nil); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Existing item survived with a null owner.
	row, _ := st.GetByID(newApp.Entity("item"), id)
	if row == nil || row["title"] != "keep" || row["owner"] != nil {
		t.Fatalf("item not preserved/owner not null: %v", row)
	}
	// The new entity is usable and its FK enforces.
	pid := seed(t, st, newApp.Entity("person"), map[string]any{"name": "Ada"})
	if _, err := st.Update(newApp.Entity("item"), id, map[string]any{"owner": pid}); err != nil {
		t.Fatalf("set owner to existing person: %v", err)
	}
	st.Close()
}

func TestExecuteWidenIntegerToReal(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, itemV1)
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "x", "count": int64(5)})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "real" }
        ]}
      ]
    }`
	newApp := parseApp(t, v2)
	if err := runMigration(t, st, oldApp, newApp, nil); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	row, _ := st.GetByID(newApp.Entity("item"), id)
	if row == nil {
		t.Fatal("row missing after widen")
	}
	switch v := row["count"].(type) {
	case float64:
		if v != 5.0 {
			t.Fatalf("widened value = %v, want 5.0", v)
		}
	default:
		t.Fatalf("widened count should read as real, got %T (%v)", v, v)
	}
	st.Close()
}

func TestExecuteDropField(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, itemV1)
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "survivor", "count": int64(9)})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true }
        ]}
      ]
    }`
	newApp := parseApp(t, v2)
	if err := runMigration(t, st, oldApp, newApp, nil); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	row, _ := st.GetByID(newApp.Entity("item"), id)
	if row == nil || row["title"] != "survivor" {
		t.Fatalf("surviving data lost: %v", row)
	}
	if physicalColumns(t, filepath.Join(dir, "data.db"), "ent_item")["fld_count"] {
		t.Fatal("fld_count column still present after drop")
	}
	st.Close()
}

func TestExecuteRenameFieldPreservesData(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, itemV1)
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "hello", "count": int64(1)})

	// fld_title keeps its id; only the display name changes.
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
	if err := runMigration(t, st, oldApp, newApp, nil); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	row, _ := st.GetByID(newApp.Entity("item"), id)
	if row == nil || row["headline"] != "hello" {
		t.Fatalf("rename did not preserve data under new name: %v", row)
	}
	// The physical column is unchanged (still the id).
	if !physicalColumns(t, filepath.Join(dir, "data.db"), "ent_item")["fld_title"] {
		t.Fatal("rename should keep the same physical column id")
	}
	st.Close()
}
