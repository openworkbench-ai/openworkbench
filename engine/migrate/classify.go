package migrate

import "pocketknife/schema"

// Classify labels an operation as ClassSafe (information-preserving, auto-apply)
// or ClassDestructive (information-losing, gated behind a witness, an explicit
// confirm, and a snapshot). It is a pure function of the operation's structure:
// it never reads op.Annotation or any other caller hint. This is the data-safety
// guarantee — a caller cannot talk the engine into treating a destructive change
// as safe.
//
// The boundary is exactly: can every existing row map forward with no loss and no
// ambiguity? Yes -> safe. No -> destructive. When a case is unclear, it is
// classified destructive: a false "safe" loses data, a false "destructive" only
// asks for a confirm.
func Classify(op Operation) Class {
	switch op.Kind {

	// Always information-preserving.
	case OpAddEntity, OpRenameEntity, OpRenameField:
		return ClassSafe

	// Always information-losing.
	case OpDropEntity, OpDropField, OpChangeReference:
		// A reference change can re-point or re-scope a foreign key in ways that
		// may orphan existing rows; gate it.
		return ClassDestructive

	// Adding a field is safe only if existing rows can be filled without a
	// witness: the column is nullable, or it carries a default. A new required
	// field with no default needs a backfill.
	case OpAddField:
		if !op.AfterField.Required || op.AfterField.HasDefault {
			return ClassSafe
		}
		return ClassDestructive

	// A type change is safe only when it strictly widens the value domain. The one
	// such case in v1 is integer -> real; everything else may truncate or fail to
	// parse and is destructive.
	case OpChangeType:
		if isWidening(op.BeforeField.Type, op.AfterField.Type) {
			return ClassSafe
		}
		return ClassDestructive

	// Relaxing nullability (required -> optional) is safe; tightening it
	// (optional -> required) may strand existing nulls and needs a backfill.
	case OpChangeRequired:
		if op.BeforeField.Required && !op.AfterField.Required {
			return ClassSafe
		}
		return ClassDestructive

	// Dropping a uniqueness constraint is safe; adding one may collide with
	// existing duplicates.
	case OpChangeUnique:
		if op.BeforeField.Unique && !op.AfterField.Unique {
			return ClassSafe
		}
		return ClassDestructive

	// Adding enum values is safe; removing any value strands rows that hold it and
	// needs a remap.
	case OpChangeEnum:
		if enumRemovedValues(op.BeforeField, op.AfterField) {
			return ClassDestructive
		}
		return ClassSafe

	default:
		// Unknown operation kinds are treated as destructive by default.
		return ClassDestructive
	}
}

// Classify computes and stores the class of every operation in the changeset. It
// always overwrites any pre-existing Class and ignores Annotation entirely.
func (cs *Changeset) Classify() {
	for i := range cs.Ops {
		cs.Ops[i].Class = Classify(cs.Ops[i])
	}
}

// HasDestructive reports whether the changeset contains any destructive
// operation. It classifies on demand, so it is correct even if Classify has not
// been called.
func (cs *Changeset) HasDestructive() bool {
	for _, op := range cs.Ops {
		if Classify(op) == ClassDestructive {
			return true
		}
	}
	return false
}

// Destructive returns the destructive operations in the changeset, classified.
func (cs *Changeset) Destructive() []Operation {
	var out []Operation
	for _, op := range cs.Ops {
		op.Class = Classify(op)
		if op.Class == ClassDestructive {
			out = append(out, op)
		}
	}
	return out
}

// isWidening reports whether a type change strictly grows the value domain with
// no possible loss. v1 recognises only integer -> real.
func isWidening(from, to schema.FieldType) bool {
	return from == schema.TypeInteger && to == schema.TypeReal
}

// enumRemovedValues reports whether any value present in before is absent from
// after (i.e. the change removes at least one enum member).
func enumRemovedValues(before, after *schema.Field) bool {
	keep := make(map[string]bool, len(after.Values))
	for _, v := range after.Values {
		keep[v] = true
	}
	for _, v := range before.Values {
		if !keep[v] {
			return true
		}
	}
	return false
}
