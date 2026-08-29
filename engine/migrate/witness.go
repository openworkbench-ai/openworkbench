package migrate

import (
	"fmt"
	"strings"

	"pocketknife/schema"
)

// A Witness is the declared, declarative rule a destructive operation requires
// before it may run. The vocabulary is closed and small — there is no
// Turing-complete hook, no arbitrary code, no callback. A destructive operation
// with no witness refuses to run; there is no default and no silent coercion.
//
// The three forms map one-to-one to the three destructive shapes that can still
// be applied with an explicit, declared intent:
//
//   - WitnessCoerce   — a type narrowing (e.g. real -> integer): how to map each
//     value (truncate, round, or fail the migration on any lossy value).
//   - WitnessBackfill — a nullable -> not-null tightening over existing nulls:
//     the value to write into rows that are currently null.
//   - WitnessRemap    — an enum value removed: how to rewrite rows still holding
//     a dropped value (old value -> replacement value).
//
// Enforcement (requiring the right witness for each destructive op, and applying
// it during execution) is wired in the witness/executor steps.
type Witness struct {
	Kind WitnessKind `json:"kind"`

	// Coerce names how a narrowing maps each value (WitnessCoerce).
	Coerce CoerceMode `json:"coerce,omitempty"`

	// Backfill is the value written into currently-null rows (WitnessBackfill).
	Backfill any `json:"backfill,omitempty"`

	// Remap rewrites rows holding a removed enum value: old -> new (WitnessRemap).
	Remap map[string]string `json:"remap,omitempty"`
}

// WitnessKind is the closed set of witness forms.
type WitnessKind string

const (
	WitnessCoerce   WitnessKind = "coerce"
	WitnessBackfill WitnessKind = "backfill"
	WitnessRemap    WitnessKind = "remap"
)

// CoerceMode is the closed set of value-narrowing strategies.
type CoerceMode string

const (
	// CoerceTruncate drops the fractional part (real -> integer) or otherwise
	// takes the value's representable prefix.
	CoerceTruncate CoerceMode = "truncate"
	// CoerceRound rounds to the nearest representable value.
	CoerceRound CoerceMode = "round"
	// CoerceFail aborts the migration if any row would lose information.
	CoerceFail CoerceMode = "fail"
)

// witnessNeeded returns the kind of witness a destructive operation requires
// before it can run, or "" if it needs none. A drop discards data by intent and
// needs only an explicit confirmation, not a witness. Enum value removals and
// reference changes are enforced structurally by the rebuild (CHECK constraints
// and foreign_key_check), so they too need no mandatory witness up front.
func witnessNeeded(op Operation) WitnessKind {
	switch op.Kind {
	case OpChangeType:
		if !isWidening(op.BeforeField.Type, op.AfterField.Type) {
			return WitnessCoerce
		}
	case OpChangeRequired:
		if !op.BeforeField.Required && op.AfterField.Required {
			return WitnessBackfill
		}
	case OpAddField:
		if op.AfterField.Required && !op.AfterField.HasDefault {
			return WitnessBackfill
		}
	}
	return ""
}

// MissingWitnesses returns the operations that require a witness of a specific
// kind but do not carry one (or carry the wrong kind). The apply flow refuses to
// run while this is non-empty — a destructive op never coerces silently and never
// falls back to a default.
func (cs *Changeset) MissingWitnesses() []Operation {
	var out []Operation
	for _, op := range cs.Ops {
		need := witnessNeeded(op)
		if need == "" {
			continue
		}
		if op.Witness == nil || op.Witness.Kind != need {
			out = append(out, op)
		}
	}
	return out
}

// --- witness application: building the SQL that realises a witness during a
// table rebuild. These render schema constants and declared witness values only;
// there is never any request data here, but string literals are single-quote
// escaped defensively all the same.

// sqlLiteral renders a Go value as a SQL literal appropriate to a field type.
// Used for an added field's default and for a backfill witness value.
func sqlLiteral(v any, t schema.FieldType) string {
	if v == nil {
		return "NULL"
	}
	switch t {
	case schema.TypeInteger:
		switch n := v.(type) {
		case int64:
			return fmt.Sprintf("%d", n)
		case int:
			return fmt.Sprintf("%d", n)
		case float64:
			return fmt.Sprintf("%d", int64(n))
		}
	case schema.TypeReal:
		switch n := v.(type) {
		case float64:
			return fmt.Sprintf("%g", n)
		case int64:
			return fmt.Sprintf("%g", float64(n))
		}
	case schema.TypeBoolean:
		if b, ok := v.(bool); ok {
			if b {
				return "1"
			}
			return "0"
		}
	}
	// text, datetime, enum, reference, and any fallthrough: a quoted string.
	return "'" + strings.ReplaceAll(fmt.Sprintf("%v", v), "'", "''") + "'"
}

// coerceExpr returns the SQL expression that narrows a column's value to a new
// type under the given mode. CoerceFail produces no coercion expression; the
// rebuild verifies losslessness separately and aborts on any lossy row.
func coerceExpr(col string, to schema.FieldType, mode CoerceMode) (string, error) {
	switch mode {
	case CoerceTruncate:
		// CAST to INTEGER truncates toward zero; to REAL is exact.
		return fmt.Sprintf("CAST(%s AS %s)", col, sqlAffinity(to)), nil
	case CoerceRound:
		if to == schema.TypeInteger {
			return fmt.Sprintf("CAST(round(%s) AS INTEGER)", col), nil
		}
		return fmt.Sprintf("CAST(%s AS %s)", col, sqlAffinity(to)), nil
	case CoerceFail:
		// No transform: the value is copied as-is and a guard rejects lossy rows.
		return col, nil
	default:
		return "", fmt.Errorf("unknown coerce mode %q", mode)
	}
}

// lossGuard returns a boolean SQL predicate that is true for a row whose value
// cannot be narrowed to the target type without loss. Used to enforce
// CoerceFail: if any row matches, the migration aborts.
func lossGuard(col string, to schema.FieldType) string {
	// A value is lossy iff it differs from its cast to the target affinity.
	return fmt.Sprintf("%s IS NOT NULL AND %s <> CAST(%s AS %s)", col, col, col, sqlAffinity(to))
}

// remapExpr returns a CASE expression rewriting rows that hold a removed enum
// value to their declared replacement, leaving others unchanged.
func remapExpr(col string, w *Witness) string {
	var b strings.Builder
	b.WriteString("CASE " + col)
	for from, to := range w.Remap {
		fmt.Fprintf(&b, " WHEN %s THEN %s",
			sqlLiteral(from, schema.TypeText), sqlLiteral(to, schema.TypeText))
	}
	b.WriteString(" ELSE " + col + " END")
	return b.String()
}

// sqlAffinity maps a field type to the SQLite affinity keyword used in CAST.
func sqlAffinity(t schema.FieldType) string {
	switch t {
	case schema.TypeInteger, schema.TypeBoolean:
		return "INTEGER"
	case schema.TypeReal:
		return "REAL"
	default:
		return "TEXT"
	}
}
