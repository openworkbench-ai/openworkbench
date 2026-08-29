package materialize_test

import (
	"strings"
	"testing"

	"pocketknife/materialize"
	"pocketknife/validate"
)

func compile(t *testing.T, body string) []string {
	t.Helper()
	app, errs := validate.Manifest([]byte(body))
	if len(errs) > 0 {
		t.Fatalf("manifest invalid: %v", errs)
	}
	stmts, err := materialize.Statements(app)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	return stmts
}

func joinAll(stmts []string) string { return strings.Join(stmts, "\n") }

func TestPlatformColumnsAlwaysPresent(t *testing.T) {
	ddl := joinAll(compile(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "ent_thing", "name": "thing", "fields": [
        { "id": "fld_title", "name": "title", "type": "text" }
      ]}]
    }`))
	for _, want := range []string{
		"id TEXT PRIMARY KEY",
		"created_at TEXT NOT NULL",
		"updated_at TEXT NOT NULL",
		"CREATE TABLE IF NOT EXISTS ent_thing",
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("DDL missing %q:\n%s", want, ddl)
		}
	}
}

// TestTypeMappingAndChecks verifies the type → column mapping and that physical
// identifiers are keyed by stable id, not display name. Each field's id differs
// from its name so the assertions prove id-keying: the id appears as the column,
// the name does not appear as an identifier.
func TestTypeMappingAndChecks(t *testing.T) {
	ddl := joinAll(compile(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "ent_thing", "name": "thing", "fields": [
        { "id": "fld_name",   "name": "name",   "type": "text", "required": true, "min": 1, "max": 50, "unique": true },
        { "id": "fld_score",  "name": "score",  "type": "integer", "min": 0, "max": 100 },
        { "id": "fld_ratio",  "name": "ratio",  "type": "real" },
        { "id": "fld_active", "name": "active", "type": "boolean" },
        { "id": "fld_when",   "name": "when",   "type": "datetime" },
        { "id": "fld_kind",   "name": "kind",   "type": "enum", "values": ["low","high"] }
      ]}]
    }`))

	checks := []string{
		"fld_name TEXT NOT NULL",
		"length(fld_name) >= 1",
		"length(fld_name) <= 50",
		"fld_score INTEGER",
		"fld_score >= 0",
		"fld_score <= 100",
		"fld_ratio REAL",
		"fld_active INTEGER",
		"fld_active IN (0, 1)",
		"fld_when TEXT",
		"fld_kind TEXT",
		"fld_kind IN ('low', 'high')",
		"CREATE UNIQUE INDEX IF NOT EXISTS ux_ent_thing_fld_name ON ent_thing(fld_name)",
	}
	for _, want := range checks {
		if !strings.Contains(ddl, want) {
			t.Fatalf("DDL missing %q:\n%s", want, ddl)
		}
	}

	// The table is keyed by the entity id, never the display name (D1).
	if strings.Contains(ddl, "CREATE TABLE IF NOT EXISTS thing") {
		t.Fatalf("table keyed by display name instead of id:\n%s", ddl)
	}
}

func TestReferenceForeignKey(t *testing.T) {
	ddl := joinAll(compile(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_project", "name": "project", "fields": [
          { "id": "fld_pname", "name": "name", "type": "text", "required": true }
        ]},
        { "id": "ent_task", "name": "task", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true },
          { "id": "fld_proj", "name": "project", "type": "reference", "target": "ent_project", "onDelete": "set_null" }
        ]}
      ]
    }`))

	// The FK is keyed by ids on both sides: the field id as the local column and
	// the target entity's id as the referenced table.
	if !strings.Contains(ddl, "FOREIGN KEY (fld_proj) REFERENCES ent_project(id) ON DELETE SET NULL") {
		t.Fatalf("missing id-keyed FK clause:\n%s", ddl)
	}
}

func TestEnumLiteralsAreQuoteEscaped(t *testing.T) {
	ddl := joinAll(compile(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "ent_thing", "name": "thing", "fields": [
        { "id": "fld_mood", "name": "mood", "type": "enum", "values": ["it's fine", "ok"] }
      ]}]
    }`))
	// A value containing a single quote must be doubled so it cannot break out
	// of the literal: it's fine -> 'it''s fine'.
	if !strings.Contains(ddl, "'it''s fine'") {
		t.Fatalf("enum quote not escaped:\n%s", ddl)
	}
}
