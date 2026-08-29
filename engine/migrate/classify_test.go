package migrate

import (
	"testing"

	"pocketknife/schema"
)

func field(id string, t schema.FieldType, mut func(*schema.Field)) *schema.Field {
	f := &schema.Field{ID: id, Name: id, Type: t}
	if mut != nil {
		mut(f)
	}
	return f
}

// TestClassifyBoundaries exercises both sides of every safe/destructive line.
func TestClassifyBoundaries(t *testing.T) {
	req := func(f *schema.Field) { f.Required = true }
	uniq := func(f *schema.Field) { f.Unique = true }
	def := func(f *schema.Field) { f.HasDefault = true; f.Default = "x" }

	cases := []struct {
		name string
		op   Operation
		want Class
	}{
		// Entity structure.
		{"add entity", Operation{Kind: OpAddEntity}, ClassSafe},
		{"rename entity", Operation{Kind: OpRenameEntity}, ClassSafe},
		{"drop entity", Operation{Kind: OpDropEntity}, ClassDestructive},

		// Field structure.
		{"rename field", Operation{Kind: OpRenameField}, ClassSafe},
		{"drop field", Operation{Kind: OpDropField}, ClassDestructive},

		// Add field: nullable / default safe, required-without-default destructive.
		{"add nullable field", Operation{Kind: OpAddField, AfterField: field("f", schema.TypeText, nil)}, ClassSafe},
		{"add field with default", Operation{Kind: OpAddField, AfterField: field("f", schema.TypeText, def)}, ClassSafe},
		{"add required field no default", Operation{Kind: OpAddField, AfterField: field("f", schema.TypeText, req)}, ClassDestructive},

		// Type changes: only integer->real widens.
		{"widen integer->real", Operation{Kind: OpChangeType, BeforeField: field("f", schema.TypeInteger, nil), AfterField: field("f", schema.TypeReal, nil)}, ClassSafe},
		{"narrow real->integer", Operation{Kind: OpChangeType, BeforeField: field("f", schema.TypeReal, nil), AfterField: field("f", schema.TypeInteger, nil)}, ClassDestructive},
		{"narrow text->integer", Operation{Kind: OpChangeType, BeforeField: field("f", schema.TypeText, nil), AfterField: field("f", schema.TypeInteger, nil)}, ClassDestructive},
		{"change boolean->integer (not whitelisted)", Operation{Kind: OpChangeType, BeforeField: field("f", schema.TypeBoolean, nil), AfterField: field("f", schema.TypeInteger, nil)}, ClassDestructive},

		// Nullability.
		{"relax required->optional", Operation{Kind: OpChangeRequired, BeforeField: field("f", schema.TypeText, req), AfterField: field("f", schema.TypeText, nil)}, ClassSafe},
		{"tighten optional->required", Operation{Kind: OpChangeRequired, BeforeField: field("f", schema.TypeText, nil), AfterField: field("f", schema.TypeText, req)}, ClassDestructive},

		// Uniqueness.
		{"drop unique", Operation{Kind: OpChangeUnique, BeforeField: field("f", schema.TypeText, uniq), AfterField: field("f", schema.TypeText, nil)}, ClassSafe},
		{"add unique", Operation{Kind: OpChangeUnique, BeforeField: field("f", schema.TypeText, nil), AfterField: field("f", schema.TypeText, uniq)}, ClassDestructive},

		// Enum membership.
		{"add enum value", Operation{Kind: OpChangeEnum,
			BeforeField: field("f", schema.TypeEnum, func(f *schema.Field) { f.Values = []string{"a", "b"} }),
			AfterField:  field("f", schema.TypeEnum, func(f *schema.Field) { f.Values = []string{"a", "b", "c"} })}, ClassSafe},
		{"remove enum value", Operation{Kind: OpChangeEnum,
			BeforeField: field("f", schema.TypeEnum, func(f *schema.Field) { f.Values = []string{"a", "b", "c"} }),
			AfterField:  field("f", schema.TypeEnum, func(f *schema.Field) { f.Values = []string{"a", "b"} })}, ClassDestructive},

		// Reference re-target.
		{"change reference", Operation{Kind: OpChangeReference}, ClassDestructive},
	}

	for _, c := range cases {
		if got := Classify(c.op); got != c.want {
			t.Errorf("%s: Classify = %q, want %q", c.name, got, c.want)
		}
	}
}

// TestClassifyIgnoresAnnotation proves the computed classification overrides any
// caller-supplied annotation: a destructive op annotated "safe" stays
// destructive. The caller cannot talk the engine into a downgrade.
func TestClassifyIgnoresAnnotation(t *testing.T) {
	op := Operation{
		Kind:        OpDropField,
		EntityID:    "ent_book",
		FieldID:     "fld_author",
		BeforeField: field("fld_author", schema.TypeText, nil),
		Annotation:  ClassSafe, // hostile/mistaken claim
	}
	if got := Classify(op); got != ClassDestructive {
		t.Fatalf("annotation must not downgrade classification: got %q", got)
	}

	cs := &Changeset{Ops: []Operation{op}}
	cs.Classify()
	if cs.Ops[0].Class != ClassDestructive {
		t.Fatalf("Changeset.Classify must ignore annotation: got %q", cs.Ops[0].Class)
	}
	if !cs.HasDestructive() || len(cs.Destructive()) != 1 {
		t.Fatal("destructive op not reported as destructive")
	}
}
