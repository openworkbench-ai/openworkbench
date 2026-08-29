package migrate

import (
	"strings"
	"testing"

	"pocketknife/schema"
)

func TestChangesetIsEmpty(t *testing.T) {
	var cs Changeset
	if !cs.IsEmpty() {
		t.Fatal("zero changeset should be empty")
	}
	cs.Ops = append(cs.Ops, Operation{Kind: OpAddEntity, EntityID: "ent_x"})
	if cs.IsEmpty() {
		t.Fatal("changeset with an op should not be empty")
	}
}

func TestOperationStringIncludesComputedClass(t *testing.T) {
	op := Operation{
		Kind:        OpRenameField,
		EntityID:    "ent_book",
		FieldID:     "fld_title",
		BeforeField: &schema.Field{ID: "fld_title", Name: "title"},
		AfterField:  &schema.Field{ID: "fld_title", Name: "name"},
	}
	// Unclassified ops render without a class tag.
	if got := op.String(); strings.Contains(got, "[") {
		t.Fatalf("unclassified op should not show a class tag: %q", got)
	}
	// Once classified, the class appears.
	op.Class = ClassSafe
	if got := op.String(); !strings.Contains(got, "[safe]") {
		t.Fatalf("classified op should show its class: %q", got)
	}
	// The rename's before/after names are visible for auditability.
	if got := op.String(); !strings.Contains(got, `"title"`) || !strings.Contains(got, `"name"`) {
		t.Fatalf("rename description should show both names: %q", got)
	}
}

// TestAnnotationIsIndependentOfClass documents the verification seam: a
// caller-supplied Annotation lives on its own field and never feeds Class. The
// engine's classifier is the only thing that may set Class.
func TestAnnotationIsIndependentOfClass(t *testing.T) {
	op := Operation{Kind: OpDropField, EntityID: "ent_book", FieldID: "fld_author"}
	op.Annotation = ClassSafe // a hostile/mistaken caller claims "safe"
	if op.Class != ClassUnclassified {
		t.Fatalf("annotation must not populate Class; Class = %q", op.Class)
	}
}
