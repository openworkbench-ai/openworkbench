package migrate

import (
	"testing"

	"pocketknife/schema"
	"pocketknife/validate"
)

// parseApp parses a manifest through the real validator so the diff tests run
// against the same typed model the runtime uses.
func parseApp(t *testing.T, body string) *schema.App {
	t.Helper()
	app, errs := validate.Manifest([]byte(body))
	if len(errs) > 0 {
		t.Fatalf("manifest invalid: %v", errs)
	}
	return app
}

// opsOf returns the operations of a given kind in a changeset.
func opsOf(cs *Changeset, kind OpKind) []Operation {
	var out []Operation
	for _, o := range cs.Ops {
		if o.Kind == kind {
			out = append(out, o)
		}
	}
	return out
}

func mustOne(t *testing.T, cs *Changeset, kind OpKind) Operation {
	t.Helper()
	got := opsOf(cs, kind)
	if len(got) != 1 {
		t.Fatalf("expected exactly one %s op, got %d (all ops: %v)", kind, len(got), cs.Ops)
	}
	return got[0]
}

// A single-entity tracker with one integer and one text field, used as the old
// side of most diffs.
const trackerV1 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 1 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true },
      { "id": "fld_count", "name": "count", "type": "integer" }
    ]}
  ]
}`

func TestDiffRenameFieldIsSameID(t *testing.T) {
	// Same field id, new name: a rename, not a drop-plus-add.
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "headline", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" }
        ]}
      ]
    }`
	cs := Diff(parseApp(t, trackerV1), parseApp(t, v2))

	if n := len(opsOf(cs, OpAddField)) + len(opsOf(cs, OpDropField)); n != 0 {
		t.Fatalf("rename must not produce add/drop ops, got %d", n)
	}
	op := mustOne(t, cs, OpRenameField)
	if op.FieldID != "fld_title" || op.BeforeField.Name != "title" || op.AfterField.Name != "headline" {
		t.Fatalf("unexpected rename op: %+v", op)
	}
	if cs.FromVersion != 1 || cs.ToVersion != 2 {
		t.Fatalf("version metadata wrong: %d -> %d", cs.FromVersion, cs.ToVersion)
	}
}

func TestDiffAddAndDropFieldAreIDBased(t *testing.T) {
	// New field id appears; an old field id disappears.
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true },
          { "id": "fld_note", "name": "note", "type": "text" }
        ]}
      ]
    }`
	cs := Diff(parseApp(t, trackerV1), parseApp(t, v2))

	add := mustOne(t, cs, OpAddField)
	if add.FieldID != "fld_note" || add.AfterField.Name != "note" {
		t.Fatalf("unexpected add op: %+v", add)
	}
	drop := mustOne(t, cs, OpDropField)
	if drop.FieldID != "fld_count" || drop.BeforeField.Name != "count" {
		t.Fatalf("unexpected drop op: %+v", drop)
	}
}

func TestDiffTypeChange(t *testing.T) {
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "real" }
        ]}
      ]
    }`
	cs := Diff(parseApp(t, trackerV1), parseApp(t, v2))
	op := mustOne(t, cs, OpChangeType)
	if op.BeforeField.Type != schema.TypeInteger || op.AfterField.Type != schema.TypeReal {
		t.Fatalf("unexpected type change: %s -> %s", op.BeforeField.Type, op.AfterField.Type)
	}
}

func TestDiffConstraintChanges(t *testing.T) {
	// count: nullable -> required and gains uniqueness.
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer", "required": true, "unique": true }
        ]}
      ]
    }`
	cs := Diff(parseApp(t, trackerV1), parseApp(t, v2))

	req := mustOne(t, cs, OpChangeRequired)
	if req.BeforeField.Required || !req.AfterField.Required {
		t.Fatalf("required change wrong: %v -> %v", req.BeforeField.Required, req.AfterField.Required)
	}
	uniq := mustOne(t, cs, OpChangeUnique)
	if uniq.BeforeField.Unique || !uniq.AfterField.Unique {
		t.Fatalf("unique change wrong: %v -> %v", uniq.BeforeField.Unique, uniq.AfterField.Unique)
	}
}

func TestDiffEnumMembershipChange(t *testing.T) {
	const v1 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 1 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_status", "name": "status", "type": "enum", "values": ["todo", "doing", "done"] }
        ]}
      ]
    }`
	// Remove "doing", add "blocked". Reordering the rest must not matter.
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_status", "name": "status", "type": "enum", "values": ["done", "todo", "blocked"] }
        ]}
      ]
    }`
	cs := Diff(parseApp(t, v1), parseApp(t, v2))
	op := mustOne(t, cs, OpChangeEnum)
	if op.FieldID != "fld_status" {
		t.Fatalf("unexpected enum op: %+v", op)
	}

	// A pure reorder is not a change.
	const v2reorder = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_status", "name": "status", "type": "enum", "values": ["done", "todo", "doing"] }
        ]}
      ]
    }`
	if cs := Diff(parseApp(t, v1), parseApp(t, v2reorder)); len(cs.Ops) != 0 {
		t.Fatalf("reordering enum values should be a no-op, got %v", cs.Ops)
	}
}

func TestDiffAddEntityWithReference(t *testing.T) {
	// v2 adds a new entity and a reference field pointing at it.
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true },
          { "id": "fld_count", "name": "count", "type": "integer" },
          { "id": "fld_owner", "name": "owner", "type": "reference", "target": "ent_person", "onDelete": "set_null" }
        ]}
        ,{ "id": "ent_person", "name": "person", "fields": [
          { "id": "fld_pname", "name": "name", "type": "text", "required": true }
        ]}
      ]
    }`
	cs := Diff(parseApp(t, trackerV1), parseApp(t, v2))

	addEnt := mustOne(t, cs, OpAddEntity)
	if addEnt.EntityID != "ent_person" {
		t.Fatalf("expected added entity ent_person, got %s", addEnt.EntityID)
	}
	addField := mustOne(t, cs, OpAddField)
	if addField.FieldID != "fld_owner" || addField.AfterField.Type != schema.TypeReference {
		t.Fatalf("expected added reference field fld_owner, got %+v", addField)
	}
}

func TestDiffRenameEntityAndDropEntity(t *testing.T) {
	const v1 = `{
      "app": { "id": "app", "name": "App", "version": 1 },
      "entities": [
        { "id": "ent_a", "name": "alpha", "fields": [
          { "id": "fld_x", "name": "x", "type": "text" }
        ]},
        { "id": "ent_b", "name": "beta", "fields": [
          { "id": "fld_y", "name": "y", "type": "text" }
        ]}
      ]
    }`
	// Rename ent_a (same id, new name); drop ent_b entirely.
	const v2 = `{
      "app": { "id": "app", "name": "App", "version": 2 },
      "entities": [
        { "id": "ent_a", "name": "alphabet", "fields": [
          { "id": "fld_x", "name": "x", "type": "text" }
        ]}
      ]
    }`
	cs := Diff(parseApp(t, v1), parseApp(t, v2))

	ren := mustOne(t, cs, OpRenameEntity)
	if ren.BeforeEntity.Name != "alpha" || ren.AfterEntity.Name != "alphabet" {
		t.Fatalf("unexpected entity rename: %+v", ren)
	}
	drop := mustOne(t, cs, OpDropEntity)
	if drop.EntityID != "ent_b" {
		t.Fatalf("expected dropped entity ent_b, got %s", drop.EntityID)
	}
}

func TestDiffIdenticalManifestsIsEmpty(t *testing.T) {
	cs := Diff(parseApp(t, trackerV1), parseApp(t, trackerV1))
	if !cs.IsEmpty() {
		t.Fatalf("identical manifests should diff to empty, got %v", cs.Ops)
	}
}
