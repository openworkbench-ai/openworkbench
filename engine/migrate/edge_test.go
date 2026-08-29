package migrate

import (
	"context"
	"testing"

	"pocketknife/store"
	"pocketknife/validate"
)

// Edge-case coverage beyond the §5 acceptance table: combined changes, reference
// re-targeting, both remaining coerce modes, uniqueness relaxation, and the
// interaction with the validator that makes some "edge" migrations impossible to
// express in the first place.

const edgeItemV1 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 1 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true },
      { "id": "fld_count", "name": "count", "type": "integer" }
    ]}
  ]
}`

// Adding a required field with a default backfills existing rows and is safe.
func TestEdgeAddRequiredFieldWithDefault(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, edgeItemV1)
	defer st.Close()
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "x", "count": int64(1)})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [{ "id": "ent_item", "name": "item", "fields": [
        { "id": "fld_title", "name": "title", "type": "text", "required": true },
        { "id": "fld_count", "name": "count", "type": "integer" },
        { "id": "fld_tag", "name": "tag", "type": "text", "required": true, "default": "none" }
      ]}]
    }`
	newApp := parseApp(t, v2)

	// It must classify safe (it is information-preserving via the default).
	cs := Diff(oldApp, newApp)
	cs.Classify()
	if cs.HasDestructive() {
		t.Fatal("adding a required field with a default should be safe")
	}
	if err := Execute(context.Background(), st, oldApp, newApp, cs); err != nil {
		t.Fatalf("add required-with-default: %v", err)
	}
	row, _ := st.GetByID(newApp.Entity("item"), id)
	if row["tag"] != "none" {
		t.Fatalf("existing row not backfilled with default: %v", row["tag"])
	}
}

// A required field with a single-quote in its default must not break the DDL.
func TestEdgeAddRequiredFieldWithQuotedDefault(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, edgeItemV1)
	defer st.Close()
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "x"})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [{ "id": "ent_item", "name": "item", "fields": [
        { "id": "fld_title", "name": "title", "type": "text", "required": true },
        { "id": "fld_count", "name": "count", "type": "integer" },
        { "id": "fld_note", "name": "note", "type": "text", "required": true, "default": "it's fine" }
      ]}]
    }`
	newApp := parseApp(t, v2)
	if err := runMigration(t, st, oldApp, newApp, nil); err != nil {
		t.Fatalf("quoted default add: %v", err)
	}
	row, _ := st.GetByID(newApp.Entity("item"), id)
	if row["note"] != "it's fine" {
		t.Fatalf("quoted default not applied verbatim: %v", row["note"])
	}
}

// Renaming a field and changing its type in one migration: the rename is free and
// the type change rebuilds, both in a single transaction.
func TestEdgeRenameAndTypeChangeTogether(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, edgeItemV1)
	defer st.Close()
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "x", "count": int64(7)})

	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [{ "id": "ent_item", "name": "item", "fields": [
        { "id": "fld_title", "name": "title", "type": "text", "required": true },
        { "id": "fld_count", "name": "amount", "type": "real" }
      ]}]
    }`
	newApp := parseApp(t, v2)
	if err := runMigration(t, st, oldApp, newApp, nil); err != nil {
		t.Fatalf("rename+widen: %v", err)
	}
	row, _ := st.GetByID(newApp.Entity("item"), id)
	if v, ok := row["amount"].(float64); !ok || v != 7.0 {
		t.Fatalf("rename+widen lost or mistyped value: %v (%T)", row["amount"], row["amount"])
	}
}

// Re-pointing a reference to a different entity rebuilds the table and passes the
// foreign-key check.
func TestEdgeReferenceRetarget(t *testing.T) {
	const v1 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 1 },
      "entities": [
        { "id": "ent_a", "name": "a", "fields": [{ "id": "fld_an", "name": "n", "type": "text" }]},
        { "id": "ent_b", "name": "b", "fields": [{ "id": "fld_bn", "name": "n", "type": "text" }]},
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_ref", "name": "ref", "type": "reference", "target": "ent_a", "onDelete": "set_null" }
        ]}
      ]
    }`
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_a", "name": "a", "fields": [{ "id": "fld_an", "name": "n", "type": "text" }]},
        { "id": "ent_b", "name": "b", "fields": [{ "id": "fld_bn", "name": "n", "type": "text" }]},
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_ref", "name": "ref", "type": "reference", "target": "ent_b", "onDelete": "set_null" }
        ]}
      ]
    }`
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, v1)
	defer st.Close()
	seed(t, st, oldApp.Entity("item"), map[string]any{}) // null ref, so re-target is clean
	newApp := parseApp(t, v2)

	cs := Diff(oldApp, newApp)
	cs.Classify()
	if !cs.HasDestructive() {
		t.Fatal("a reference re-target should be classified destructive")
	}
	if err := Execute(context.Background(), st, oldApp, newApp, cs); err != nil {
		t.Fatalf("reference re-target: %v", err)
	}
	// The new reference now enforces against ent_b.
	bid := seed(t, st, newApp.Entity("b"), map[string]any{"n": "hello"})
	rows, _, _ := st.List(newApp.Entity("item"), store.ListQuery{Limit: 100})
	if _, err := st.Update(newApp.Entity("item"), rows[0]["id"].(string), map[string]any{"ref": bid}); err != nil {
		t.Fatalf("new reference target not usable: %v", err)
	}
}

// Coerce round narrows by rounding to nearest, distinct from truncation.
func TestEdgeCoerceRound(t *testing.T) {
	const v1 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 1 },
      "entities": [{ "id": "ent_item", "name": "item", "fields": [
        { "id": "fld_v", "name": "v", "type": "real" }
      ]}]
    }`
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [{ "id": "ent_item", "name": "item", "fields": [
        { "id": "fld_v", "name": "v", "type": "integer" }
      ]}]
    }`
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, v1)
	defer st.Close()
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"v": 3.6})
	newApp := parseApp(t, v2)
	if err := runMigration(t, st, oldApp, newApp, map[string]*Witness{
		"fld_v": {Kind: WitnessCoerce, Coerce: CoerceRound},
	}); err != nil {
		t.Fatalf("coerce round: %v", err)
	}
	row, _ := st.GetByID(newApp.Entity("item"), id)
	if got, ok := row["v"].(int64); !ok || got != 4 {
		t.Fatalf("round 3.6 -> %v, want 4", row["v"])
	}
}

// Dropping a uniqueness constraint is safe and uses a native DROP INDEX (no
// rebuild), after which previously-forbidden duplicates are accepted.
func TestEdgeDropUnique(t *testing.T) {
	const v1 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 1 },
      "entities": [{ "id": "ent_item", "name": "item", "fields": [
        { "id": "fld_code", "name": "code", "type": "text", "required": true, "unique": true }
      ]}]
    }`
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [{ "id": "ent_item", "name": "item", "fields": [
        { "id": "fld_code", "name": "code", "type": "text", "required": true }
      ]}]
    }`
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, v1)
	defer st.Close()
	seed(t, st, oldApp.Entity("item"), map[string]any{"code": "dup"})
	newApp := parseApp(t, v2)

	cs := Diff(oldApp, newApp)
	cs.Classify()
	if cs.HasDestructive() {
		t.Fatal("dropping uniqueness should be safe")
	}
	if err := Execute(context.Background(), st, oldApp, newApp, cs); err != nil {
		t.Fatalf("drop unique: %v", err)
	}
	// A duplicate code is now accepted.
	if _, err := st.Insert(newApp.Entity("item"), map[string]any{
		"id": "x2", "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z", "code": "dup",
	}); err != nil {
		t.Fatalf("duplicate should be allowed after dropping uniqueness: %v", err)
	}
}

// A migration that would leave a dangling reference cannot even be expressed: the
// validator rejects the new manifest, so the engine never sees it.
func TestEdgeDanglingReferenceRejectedByValidator(t *testing.T) {
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_child", "name": "child", "fields": [
          { "id": "fld_ref", "name": "ref", "type": "reference", "target": "ent_parent", "onDelete": "set_null" }
        ]}
      ]
    }`
	if _, errs := validate.Manifest([]byte(v2)); len(errs) == 0 {
		t.Fatal("a manifest with an unresolved reference target must be rejected")
	}
}
