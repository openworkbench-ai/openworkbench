// Package materialize turns a validated schema into SQLite DDL. It is the only
// place that knows the type → column mapping. The DDL it produces is
// idempotent (CREATE TABLE IF NOT EXISTS), so re-running boot on an unchanged
// manifest is a no-op.
//
// Physical identifiers (table, column, index, and foreign-key names) come from
// the stable id of each entity and field, never the mutable display name. The
// validator has already proven every id SQL-safe (^[a-z][a-z0-9_]*$). Keying
// storage by id makes a rename a pure manifest change with zero SQL: the column
// is the same column because it is the same id. Values are never present in DDL
// except enum CHECK literals, which are schema-definition constants, not request
// data; those are single-quote-escaped defensively.
package materialize

import (
	"fmt"
	"strings"

	"pocketknife/schema"
)

// Platform-managed columns, added to every table. The manifest must not declare
// these (the validator rejects them as reserved names).
const platformColumns = "id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL"

// Statements returns the ordered list of DDL statements for an app: one CREATE
// TABLE per entity, followed by any UNIQUE indexes. Entities are emitted in
// manifest order; references rely on SQLite allowing forward/self FK
// declarations, which hold once foreign_keys is enabled per connection.
func Statements(app *schema.App) ([]string, error) {
	var stmts []string
	var indexes []string

	for _, ent := range app.Entities {
		create, idx, err := TableDDL(app, ent, ent.ID, true)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, create)
		indexes = append(indexes, idx...)
	}
	return append(stmts, indexes...), nil
}

// TableDDL returns the CREATE TABLE statement for a single entity under the given
// physical table name, plus the CREATE UNIQUE INDEX statements for its unique
// fields (also bound to that table name). ifNotExists controls whether the create
// is guarded (boot is idempotent; a migration's table rebuild is not).
//
// The migration engine uses this to build a new table at the target schema during
// a table rebuild: it runs the create against a temporary table name, then (after
// the rename) the index statements against the final name.
func TableDDL(app *schema.App, ent *schema.Entity, table string, ifNotExists bool) (string, []string, error) {
	var cols []string
	var constraints []string
	var indexes []string

	for _, f := range ent.Fields {
		colDef, fk, err := columnDef(app, ent, f, false)
		if err != nil {
			return "", nil, err
		}
		cols = append(cols, colDef)
		if fk != "" {
			constraints = append(constraints, fk)
		}
		if f.Unique {
			indexes = append(indexes, fmt.Sprintf(
				"CREATE UNIQUE INDEX IF NOT EXISTS %s ON %s(%s);",
				UniqueIndexName(ent, f), table, f.ID))
		}
	}

	body := []string{platformColumns}
	body = append(body, cols...)
	body = append(body, constraints...)

	guard := ""
	if ifNotExists {
		guard = "IF NOT EXISTS "
	}
	create := fmt.Sprintf("CREATE TABLE %s%s (\n  %s\n);",
		guard, table, strings.Join(body, ",\n  "))
	return create, indexes, nil
}

// AddColumnDDL returns the column definition used in an ALTER TABLE ... ADD COLUMN
// statement. Unlike the table-level form, a reference's foreign key is inlined on
// the column, because ADD COLUMN cannot carry a separate table constraint.
func AddColumnDDL(app *schema.App, ent *schema.Entity, f *schema.Field) (string, error) {
	def, _, err := columnDef(app, ent, f, true)
	return def, err
}

// UniqueIndexName is the deterministic name of the unique index backing a unique
// field. The migration engine needs it to create or drop the index when a field's
// uniqueness changes.
func UniqueIndexName(ent *schema.Entity, f *schema.Field) string {
	return fmt.Sprintf("ux_%s_%s", ent.ID, f.ID)
}

// columnDef returns the column definition and, for references, the table-level
// FOREIGN KEY constraint clause. When inlineFK is true the reference is inlined on
// the column (for ADD COLUMN) and the returned clause is empty.
func columnDef(app *schema.App, ent *schema.Entity, f *schema.Field, inlineFK bool) (string, string, error) {
	var b strings.Builder
	b.WriteString(f.ID)
	b.WriteByte(' ')

	var checks []string
	fk := ""
	inlineRef := ""

	switch f.Type {
	case schema.TypeText:
		b.WriteString("TEXT")
		checks = append(checks, lengthChecks(f)...)
	case schema.TypeInteger:
		b.WriteString("INTEGER")
		checks = append(checks, rangeChecks(f)...)
	case schema.TypeReal:
		b.WriteString("REAL")
		checks = append(checks, rangeChecks(f)...)
	case schema.TypeBoolean:
		b.WriteString("INTEGER")
		checks = append(checks, fmt.Sprintf("%s IN (0, 1)", f.ID))
	case schema.TypeDatetime:
		b.WriteString("TEXT")
	case schema.TypeEnum:
		b.WriteString("TEXT")
		checks = append(checks, fmt.Sprintf("%s IN (%s)", f.ID, enumLiterals(f.Values)))
	case schema.TypeReference:
		b.WriteString("TEXT")
		target := app.EntityByID(f.Target)
		if target == nil {
			// Should be unreachable: the validator guarantees resolution.
			return "", "", fmt.Errorf("entity %q field %q references unknown target %q", ent.Name, f.Name, f.Target)
		}
		refClause := fmt.Sprintf("REFERENCES %s(id) ON DELETE %s", target.ID, onDeleteSQL(f.OnDelete))
		if inlineFK {
			inlineRef = " " + refClause
		} else {
			fk = fmt.Sprintf("FOREIGN KEY (%s) %s", f.ID, refClause)
		}
	default:
		return "", "", fmt.Errorf("entity %q field %q has unknown type %q", ent.Name, f.Name, f.Type)
	}

	if f.Required {
		b.WriteString(" NOT NULL")
	}
	for _, c := range checks {
		b.WriteString(" CHECK (")
		b.WriteString(c)
		b.WriteString(")")
	}
	b.WriteString(inlineRef)
	return b.String(), fk, nil
}

func lengthChecks(f *schema.Field) []string {
	var checks []string
	if f.Min != nil {
		checks = append(checks, fmt.Sprintf("length(%s) >= %s", f.ID, formatNum(*f.Min)))
	}
	if f.Max != nil {
		checks = append(checks, fmt.Sprintf("length(%s) <= %s", f.ID, formatNum(*f.Max)))
	}
	return checks
}

func rangeChecks(f *schema.Field) []string {
	var checks []string
	if f.Min != nil {
		checks = append(checks, fmt.Sprintf("%s >= %s", f.ID, formatNum(*f.Min)))
	}
	if f.Max != nil {
		checks = append(checks, fmt.Sprintf("%s <= %s", f.ID, formatNum(*f.Max)))
	}
	return checks
}

// formatNum renders a bound without a trailing ".0" for whole numbers, so
// integer bounds read naturally in the DDL.
func formatNum(v float64) string {
	if v == float64(int64(v)) {
		return fmt.Sprintf("%d", int64(v))
	}
	return fmt.Sprintf("%g", v)
}

func onDeleteSQL(action string) string {
	switch action {
	case schema.OnDeleteCascade:
		return "CASCADE"
	case schema.OnDeleteRestrict:
		return "RESTRICT"
	default:
		return "SET NULL"
	}
}

// enumLiterals renders the allowed enum values as SQL string literals. Enum
// values are schema constants (not request data); single quotes are doubled per
// SQL rules so a value containing a quote cannot break out of the literal.
func enumLiterals(values []string) string {
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = "'" + strings.ReplaceAll(v, "'", "''") + "'"
	}
	return strings.Join(parts, ", ")
}
