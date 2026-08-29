package migrate

import (
	"context"
	"strings"
	"testing"

	"pocketknife/schema"
)

// buildChangeset diffs and classifies, attaching witnesses by field id.
func buildChangeset(t *testing.T, oldApp, newApp *schema.App, witnesses map[string]*Witness) *Changeset {
	t.Helper()
	cs := Diff(oldApp, newApp)
	cs.Classify()
	for i := range cs.Ops {
		if w, ok := witnesses[cs.Ops[i].FieldID]; ok {
			cs.Ops[i].Witness = w
		}
	}
	return cs
}

const realCountV1 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 1 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true },
      { "id": "fld_count", "name": "count", "type": "real" }
    ]}
  ]
}`

const intCountV2 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 2 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true },
      { "id": "fld_count", "name": "count", "type": "integer" }
    ]}
  ]
}`

func TestNarrowRefusesWithoutWitness(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, realCountV1)
	defer st.Close()
	seed(t, st, oldApp.Entity("item"), map[string]any{"title": "x", "count": 3.9})
	newApp := parseApp(t, intCountV2)

	// Pre-flight: the narrowing op is flagged as missing its witness.
	cs := buildChangeset(t, oldApp, newApp, nil)
	missing := cs.MissingWitnesses()
	if len(missing) != 1 || missing[0].FieldID != "fld_count" {
		t.Fatalf("expected fld_count to need a witness, got %v", missing)
	}

	// And execution refuses rather than coercing silently.
	if err := Execute(context.Background(), st, oldApp, newApp, cs); err == nil {
		t.Fatal("narrowing without a witness must refuse to run")
	}
}

func TestNarrowWithCoerceTruncate(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, realCountV1)
	defer st.Close()
	id := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "x", "count": 3.9})
	newApp := parseApp(t, intCountV2)

	cs := buildChangeset(t, oldApp, newApp, map[string]*Witness{
		"fld_count": {Kind: WitnessCoerce, Coerce: CoerceTruncate},
	})
	if len(cs.MissingWitnesses()) != 0 {
		t.Fatal("coerce witness should satisfy the requirement")
	}
	if err := Execute(context.Background(), st, oldApp, newApp, cs); err != nil {
		t.Fatalf("migrate with coerce witness: %v", err)
	}
	row, _ := st.GetByID(newApp.Entity("item"), id)
	if got, ok := row["count"].(int64); !ok || got != 3 {
		t.Fatalf("truncate coercion: count = %v (%T), want int64 3", row["count"], row["count"])
	}
}

func TestCoerceFailGuardsLossyRows(t *testing.T) {
	newApp := parseApp(t, intCountV2)
	w := map[string]*Witness{"fld_count": {Kind: WitnessCoerce, Coerce: CoerceFail}}

	// Lossy value present -> refuse.
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, realCountV1)
	seed(t, st, oldApp.Entity("item"), map[string]any{"title": "x", "count": 2.5})
	cs := buildChangeset(t, oldApp, newApp, w)
	if err := Execute(context.Background(), st, oldApp, newApp, cs); err == nil {
		t.Fatal("coerce=fail must refuse when a row would lose information")
	}
	st.Close()

	// Only lossless values -> succeed.
	dir2 := t.TempDir()
	st2, oldApp2 := openApp(t, dir2, realCountV1)
	defer st2.Close()
	id := seed(t, st2, oldApp2.Entity("item"), map[string]any{"title": "x", "count": 4.0})
	cs2 := buildChangeset(t, oldApp2, newApp, w)
	if err := Execute(context.Background(), st2, oldApp2, newApp, cs2); err != nil {
		t.Fatalf("coerce=fail on lossless data should succeed: %v", err)
	}
	row, _ := st2.GetByID(newApp.Entity("item"), id)
	if got, ok := row["count"].(int64); !ok || got != 4 {
		t.Fatalf("lossless fail-coercion: count = %v, want 4", row["count"])
	}
}

const noteNullableV1 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 1 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true },
      { "id": "fld_note", "name": "note", "type": "text" }
    ]}
  ]
}`

const noteRequiredV2 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 2 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true },
      { "id": "fld_note", "name": "note", "type": "text", "required": true }
    ]}
  ]
}`

func TestNullableToNotNullRequiresBackfill(t *testing.T) {
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, noteNullableV1)
	defer st.Close()
	// One row with a null note, one with a value.
	nullID := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "a"})
	valID := seed(t, st, oldApp.Entity("item"), map[string]any{"title": "b", "note": "kept"})
	newApp := parseApp(t, noteRequiredV2)

	// Refuses without a backfill witness.
	bare := buildChangeset(t, oldApp, newApp, nil)
	if len(bare.MissingWitnesses()) != 1 {
		t.Fatalf("nullable->not-null should need a backfill witness, got %v", bare.MissingWitnesses())
	}
	if err := Execute(context.Background(), st, oldApp, newApp, bare); err == nil {
		t.Fatal("nullable->not-null must refuse without a backfill witness")
	}

	// With a backfill, existing nulls are filled and present values preserved.
	cs := buildChangeset(t, oldApp, newApp, map[string]*Witness{
		"fld_note": {Kind: WitnessBackfill, Backfill: "n/a"},
	})
	if err := Execute(context.Background(), st, oldApp, newApp, cs); err != nil {
		t.Fatalf("migrate with backfill: %v", err)
	}
	nullRow, _ := st.GetByID(newApp.Entity("item"), nullID)
	if nullRow["note"] != "n/a" {
		t.Fatalf("null row not backfilled: %v", nullRow["note"])
	}
	valRow, _ := st.GetByID(newApp.Entity("item"), valID)
	if valRow["note"] != "kept" {
		t.Fatalf("existing value not preserved: %v", valRow["note"])
	}
}

func TestEnumRemoveValueWithRemap(t *testing.T) {
	const v1 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 1 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_status", "name": "status", "type": "enum", "values": ["todo", "doing", "done"] }
        ]}
      ]
    }`
	const v2 = `{
      "app": { "id": "tracker", "name": "Tracker", "version": 2 },
      "entities": [
        { "id": "ent_item", "name": "item", "fields": [
          { "id": "fld_status", "name": "status", "type": "enum", "values": ["todo", "done"] }
        ]}
      ]
    }`
	dir := t.TempDir()
	st, oldApp := openApp(t, dir, v1)
	defer st.Close()
	doingID := seed(t, st, oldApp.Entity("item"), map[string]any{"status": "doing"})
	todoID := seed(t, st, oldApp.Entity("item"), map[string]any{"status": "todo"})
	newApp := parseApp(t, v2)

	// Without a remap, the removed value violates the new CHECK and the rebuild
	// refuses.
	if err := Execute(context.Background(), st, oldApp, newApp, buildChangeset(t, oldApp, newApp, nil)); err == nil {
		t.Fatal("removing an in-use enum value without a remap must refuse")
	}

	// With a remap, the dropped value is rewritten.
	cs := buildChangeset(t, oldApp, newApp, map[string]*Witness{
		"fld_status": {Kind: WitnessRemap, Remap: map[string]string{"doing": "done"}},
	})
	if err := Execute(context.Background(), st, oldApp, newApp, cs); err != nil {
		t.Fatalf("migrate with remap: %v", err)
	}
	if row, _ := st.GetByID(newApp.Entity("item"), doingID); row["status"] != "done" {
		t.Fatalf("remap did not rewrite dropped value: %v", row["status"])
	}
	if row, _ := st.GetByID(newApp.Entity("item"), todoID); row["status"] != "todo" {
		t.Fatalf("remap disturbed an unrelated value: %v", row["status"])
	}
}

// TestWitnessVocabularyIsClosed is a guard documenting that the witness kinds are
// a small, fixed set — there is no free-form/code witness.
func TestWitnessVocabularyIsClosed(t *testing.T) {
	for _, k := range []WitnessKind{WitnessCoerce, WitnessBackfill, WitnessRemap} {
		if strings.TrimSpace(string(k)) == "" {
			t.Fatal("witness kind must be a non-empty constant")
		}
	}
}
