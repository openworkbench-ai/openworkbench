package schema

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Fingerprint computes a deterministic digest of the parts of app that
// determine its materialized SQLite schema — the parts a hand-edited
// manifest could change without ever running a migration against the
// database that's actually on disk.
//
// Deliberately excluded, because none of it affects materialize's DDL or
// migrate's data semantics: app/entity/field Name (a rename is a pure
// manifest change — storage is keyed by stable id, and the whole point of
// id-keyed storage is that renaming moves no data and needs no migration),
// entity Operations (an API-surface restriction, not a schema fact),
// Frontend/Functions (UI/capability concerns, not row storage), and a
// field's Default value (materialize never emits a SQL DEFAULT clause at
// all — defaults are applied at the domain layer, not the database schema).
//
// Included, because each one either changes the generated DDL directly or
// changes what a stored row is allowed to mean: entity stable id, field
// stable id, Type, Required, Unique, Min, Max, enum Values (order-independent
// — reordering is not a semantic change, matching migrate/diff.go), and for
// reference fields, Target and OnDelete.
//
// Entities and fields are sorted by stable id before hashing, so reordering
// them in the manifest — itself schema-irrelevant, since storage is
// id-keyed — never changes the fingerprint. This is a small canonical
// representation hashed with SHA-256, not a hash of raw manifest JSON:
// formatting, key order, and excluded fields can never perturb the result.
func Fingerprint(app *App) string {
	entities := append([]*Entity(nil), app.Entities...)
	sort.Slice(entities, func(i, j int) bool { return entities[i].ID < entities[j].ID })

	var b strings.Builder
	for _, e := range entities {
		fmt.Fprintf(&b, "entity %s\n", e.ID)

		fields := append([]*Field(nil), e.Fields...)
		sort.Slice(fields, func(i, j int) bool { return fields[i].ID < fields[j].ID })
		for _, f := range fields {
			fmt.Fprintf(&b, "  field %s type=%s required=%t unique=%t",
				f.ID, f.Type, f.Required, f.Unique)
			writeNum(&b, " min=", f.Min)
			writeNum(&b, " max=", f.Max)
			if f.Type == TypeEnum {
				values := append([]string(nil), f.Values...)
				sort.Strings(values)
				fmt.Fprintf(&b, " values=%s", strings.Join(values, ","))
			}
			if f.Type == TypeReference {
				fmt.Fprintf(&b, " target=%s onDelete=%s", f.Target, f.OnDelete)
			}
			b.WriteByte('\n')
		}
	}

	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

// writeNum writes a nil-safe, deterministic representation of an optional
// numeric bound. strconv.FormatFloat's shortest-unambiguous form means 5 and
// 5.0 in two differently-formatted manifests both land on the same string,
// since by this point both are just the Go float64 value 5.
func writeNum(b *strings.Builder, prefix string, v *float64) {
	if v == nil {
		return
	}
	b.WriteString(prefix)
	b.WriteString(strconv.FormatFloat(*v, 'g', -1, 64))
}
