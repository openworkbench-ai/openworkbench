package migrate

import "pocketknife/schema"

// Diff computes the structural difference between two validated manifest versions
// of the same app and returns a typed, ordered Changeset. Entities and fields are
// matched entirely by stable id: a field whose id is unchanged but whose name
// differs is a rename (and moves no data), while a new id is an add and a missing
// id is a drop.
//
// Diff is a pure function of its inputs — it consults no hint, flag, or
// annotation. The Changeset it produces is the verification ground truth against
// which a future model-proposed, annotated changeset will be checked; that
// verification seam is intentionally not implemented here.
//
// Ordering is deterministic: added entities (in new-manifest order), then each
// surviving entity's own changes (in new-manifest order), then dropped entities
// (in old-manifest order). This keeps changesets reproducible and tests stable.
func Diff(oldApp, newApp *schema.App) *Changeset {
	cs := &Changeset{
		AppID:       newApp.ID,
		FromVersion: oldApp.Version,
		ToVersion:   newApp.Version,
	}

	// Added entities and changes to surviving entities, in new-manifest order.
	for _, ne := range newApp.Entities {
		oe := oldApp.EntityByID(ne.ID)
		if oe == nil {
			cs.Ops = append(cs.Ops, Operation{
				Kind:        OpAddEntity,
				EntityID:    ne.ID,
				AfterEntity: ne,
			})
			continue
		}
		cs.Ops = append(cs.Ops, diffEntity(oe, ne)...)
	}

	// Dropped entities, in old-manifest order.
	for _, oe := range oldApp.Entities {
		if newApp.EntityByID(oe.ID) == nil {
			cs.Ops = append(cs.Ops, Operation{
				Kind:         OpDropEntity,
				EntityID:     oe.ID,
				BeforeEntity: oe,
			})
		}
	}

	return cs
}

// diffEntity compares two versions of the same entity (matched by id) and emits
// the rename and field operations between them.
func diffEntity(oe, ne *schema.Entity) []Operation {
	var ops []Operation

	if oe.Name != ne.Name {
		ops = append(ops, Operation{
			Kind:         OpRenameEntity,
			EntityID:     ne.ID,
			BeforeEntity: oe,
			AfterEntity:  ne,
		})
	}

	// Added fields and changes to surviving fields, in new-manifest order.
	for _, nf := range ne.Fields {
		of := oe.FieldByID(nf.ID)
		if of == nil {
			ops = append(ops, Operation{
				Kind:       OpAddField,
				EntityID:   ne.ID,
				FieldID:    nf.ID,
				AfterField: nf,
			})
			continue
		}
		ops = append(ops, diffField(ne.ID, of, nf)...)
	}

	// Dropped fields, in old-manifest order.
	for _, of := range oe.Fields {
		if ne.FieldByID(of.ID) == nil {
			ops = append(ops, Operation{
				Kind:        OpDropField,
				EntityID:    ne.ID,
				FieldID:     of.ID,
				BeforeField: of,
			})
		}
	}

	return ops
}

// diffField compares two versions of the same field (matched by id) and emits one
// operation per independent change dimension, so each can be classified and (if
// destructive) witnessed on its own.
func diffField(entityID string, of, nf *schema.Field) []Operation {
	var ops []Operation
	mk := func(kind OpKind) Operation {
		return Operation{
			Kind:        kind,
			EntityID:    entityID,
			FieldID:     nf.ID,
			BeforeField: of,
			AfterField:  nf,
		}
	}

	if of.Name != nf.Name {
		ops = append(ops, mk(OpRenameField))
	}
	if of.Type != nf.Type {
		ops = append(ops, mk(OpChangeType))
	}
	if of.Required != nf.Required {
		ops = append(ops, mk(OpChangeRequired))
	}
	if of.Unique != nf.Unique {
		ops = append(ops, mk(OpChangeUnique))
	}
	// Enum membership is only comparable when both sides are enums; a type change
	// to/from enum is already captured by OpChangeType.
	if of.Type == schema.TypeEnum && nf.Type == schema.TypeEnum && !sameStringSet(of.Values, nf.Values) {
		ops = append(ops, mk(OpChangeEnum))
	}
	// Likewise reference target/onDelete only when both sides are references.
	if of.Type == schema.TypeReference && nf.Type == schema.TypeReference &&
		(of.Target != nf.Target || of.OnDelete != nf.OnDelete) {
		ops = append(ops, mk(OpChangeReference))
	}

	return ops
}

// sameStringSet reports whether two string slices contain the same set of
// values, ignoring order. Reordering enum values is not a semantic change.
func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	set := make(map[string]int, len(a))
	for _, v := range a {
		set[v]++
	}
	for _, v := range b {
		set[v]--
		if set[v] < 0 {
			return false
		}
	}
	return true
}
