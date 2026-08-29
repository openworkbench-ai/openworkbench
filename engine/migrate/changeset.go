// Package migrate is the trusted, headless schema-migration engine. It evolves
// an app from one manifest version to the next without losing data, behind three
// non-negotiable invariants: a snapshot is taken before any destructive change,
// the platform's computed structural diff (not any caller hint) is the ground
// truth for classification, and a migration is all-or-nothing per app.
//
// This file defines the Changeset — the typed, ordered description of structural
// change that the diff engine produces and the executor consumes. It is keyed
// entirely by stable id, so a rename (same id, new name) is visible as a rename
// rather than a drop-plus-add.
//
// No LLM participates in this phase. Each Operation carries an Annotation field
// for a future model-proposed class, but the engine ignores it: Class is always
// the value our own classifier computes. That seam is deliberately left inert.
package migrate

import (
	"fmt"

	"pocketknife/schema"
)

// OpKind is the closed set of structural operations a changeset can contain.
// Together they cover the full taxonomy: added / dropped / renamed entities and
// fields, type changes, and the constraint changes (nullability, uniqueness,
// enum membership, reference target).
type OpKind string

const (
	// Entity-level.
	OpAddEntity    OpKind = "add_entity"
	OpDropEntity   OpKind = "drop_entity"
	OpRenameEntity OpKind = "rename_entity"

	// Field-level structure.
	OpAddField    OpKind = "add_field"
	OpDropField   OpKind = "drop_field"
	OpRenameField OpKind = "rename_field"

	// Field-level type and constraints. Each is emitted independently so a field
	// that changes along several dimensions yields several operations, each
	// classified and (if destructive) witnessed on its own.
	OpChangeType      OpKind = "change_type"      // field type changed
	OpChangeRequired  OpKind = "change_required"  // nullability changed
	OpChangeUnique    OpKind = "change_unique"    // uniqueness changed
	OpChangeEnum      OpKind = "change_enum"      // enum value set changed
	OpChangeReference OpKind = "change_reference" // reference target/onDelete changed
)

// Class is the data-safety label the classifier assigns to an operation. It is
// always computed from the operation's structure; a caller cannot set it.
type Class string

const (
	// ClassUnclassified is the zero value: an operation that has not yet been run
	// through the classifier.
	ClassUnclassified Class = ""
	// ClassSafe is information-preserving and auto-applies.
	ClassSafe Class = "safe"
	// ClassDestructive is information-losing and is gated behind a witness, an
	// explicit confirmation, and a snapshot.
	ClassDestructive Class = "destructive"
)

// Operation is one structural change keyed by stable id. Before/After carry the
// relevant entity or field shape so the classifier and executor have full
// context; the fields not relevant to a given Kind are nil.
type Operation struct {
	Kind     OpKind
	EntityID string // the entity this op targets (always set)
	FieldID  string // the field this op targets ("" for entity-level ops)

	// BeforeField / AfterField hold the field shape on each side of a field-level
	// change. For an add only AfterField is set; for a drop only BeforeField.
	BeforeField *schema.Field
	AfterField  *schema.Field

	// BeforeEntity / AfterEntity hold the entity shape for entity-level ops.
	BeforeEntity *schema.Entity
	AfterEntity  *schema.Entity

	// Class is the computed data-safety label. It is populated by Classify and is
	// never read from caller input.
	Class Class

	// Witness is the declared coercion/backfill that a destructive op requires
	// before it may run. nil for safe ops, or for a destructive op awaiting one.
	Witness *Witness

	// Annotation is a future, model-proposed class. The engine never trusts it for
	// classification; it exists only for the (unimplemented) verification seam in
	// which the computed diff checks the model's claim.
	Annotation Class
}

// Changeset is the ordered, typed description of the structural change between
// two manifest versions of one app.
type Changeset struct {
	AppID       string
	FromVersion int
	ToVersion   int
	Ops         []Operation
}

// IsEmpty reports whether the changeset contains no operations (the manifests are
// structurally identical).
func (cs *Changeset) IsEmpty() bool { return len(cs.Ops) == 0 }

// describe renders a stable, human-readable summary of an operation for logs and
// errors. It never includes row data.
func (o Operation) describe() string {
	switch o.Kind {
	case OpRenameEntity:
		return fmt.Sprintf("%s %s: %q -> %q", o.Kind, o.EntityID, o.BeforeEntity.Name, o.AfterEntity.Name)
	case OpRenameField:
		return fmt.Sprintf("%s %s.%s: %q -> %q", o.Kind, o.EntityID, o.FieldID, o.BeforeField.Name, o.AfterField.Name)
	case OpChangeType:
		return fmt.Sprintf("%s %s.%s: %s -> %s", o.Kind, o.EntityID, o.FieldID, o.BeforeField.Type, o.AfterField.Type)
	case OpAddEntity, OpDropEntity:
		return fmt.Sprintf("%s %s", o.Kind, o.EntityID)
	case OpAddField, OpDropField, OpChangeRequired, OpChangeUnique, OpChangeEnum, OpChangeReference:
		return fmt.Sprintf("%s %s.%s", o.Kind, o.EntityID, o.FieldID)
	default:
		return fmt.Sprintf("%s %s.%s", o.Kind, o.EntityID, o.FieldID)
	}
}

// String renders an operation with its computed class.
func (o Operation) String() string {
	if o.Class == ClassUnclassified {
		return o.describe()
	}
	return fmt.Sprintf("[%s] %s", o.Class, o.describe())
}
