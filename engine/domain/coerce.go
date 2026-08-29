package domain

import (
	"encoding/json"
	"fmt"

	"pocketknife/schema"
	"pocketknife/store"
)

// CoerceFieldValue validates and converts one present runtime value for a
// field into its canonical storage representation. It returns
// (value, isNull, err):
//
//   - err != nil     → the value failed field validation
//   - isNull == true → the value was explicitly a JSON null
//
// This validates a *runtime row value* arriving as raw wire bytes — not a
// manifest's declared default, which validate/semantic.go's validateDefault
// checks separately, at a different time, against an already-parsed Go
// value with no JSON decoding, no reference-existence check (no store is
// open at manifest-validation time), and no datetime re-parsing (the parser
// already canonicalised it). The two are related but not the same operation
// and are deliberately not merged.
//
// This is the one place field-coercion rules live; api/ and sandbox/ each
// wrap it in their own transport-specific error shape rather than
// reimplementing the rules.
func CoerceFieldValue(app *schema.App, st RowStore, f *schema.Field, raw json.RawMessage) (any, bool, *FieldError) {
	if isJSONNull(raw) {
		return nil, true, nil
	}
	issue := func(msg string) *FieldError { return &FieldError{Field: f.Name, Message: msg} }

	switch f.Type {
	case schema.TypeText:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, false, issue("must be a string")
		}
		n := float64(len([]rune(s)))
		if f.Min != nil && n < *f.Min {
			return nil, false, issue(fmt.Sprintf("must be at least %s characters", numStr(*f.Min)))
		}
		if f.Max != nil && n > *f.Max {
			return nil, false, issue(fmt.Sprintf("must be at most %s characters", numStr(*f.Max)))
		}
		return s, false, nil

	case schema.TypeInteger:
		var jn json.Number
		if err := json.Unmarshal(raw, &jn); err != nil {
			return nil, false, issue("must be an integer")
		}
		i, err := jn.Int64()
		if err != nil {
			return nil, false, issue("must be a whole integer")
		}
		if f.Min != nil && float64(i) < *f.Min {
			return nil, false, issue(fmt.Sprintf("must be >= %s", numStr(*f.Min)))
		}
		if f.Max != nil && float64(i) > *f.Max {
			return nil, false, issue(fmt.Sprintf("must be <= %s", numStr(*f.Max)))
		}
		return i, false, nil

	case schema.TypeReal:
		var jn json.Number
		if err := json.Unmarshal(raw, &jn); err != nil {
			return nil, false, issue("must be a number")
		}
		fv, err := jn.Float64()
		if err != nil {
			return nil, false, issue("must be a number")
		}
		if f.Min != nil && fv < *f.Min {
			return nil, false, issue(fmt.Sprintf("must be >= %s", numStr(*f.Min)))
		}
		if f.Max != nil && fv > *f.Max {
			return nil, false, issue(fmt.Sprintf("must be <= %s", numStr(*f.Max)))
		}
		return fv, false, nil

	case schema.TypeBoolean:
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, false, issue("must be a boolean")
		}
		return b, false, nil

	case schema.TypeDatetime:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, false, issue("must be an ISO-8601 datetime string")
		}
		canon, err := store.CanonicalDatetime(s)
		if err != nil {
			return nil, false, issue(err.Error())
		}
		return canon, false, nil

	case schema.TypeEnum:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, false, issue("must be a string")
		}
		for _, v := range f.Values {
			if v == s {
				return s, false, nil
			}
		}
		return nil, false, issue(fmt.Sprintf("must be one of %v", f.Values))

	case schema.TypeReference:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, false, issue("must be a reference id string")
		}
		target := app.EntityByID(f.Target)
		if target == nil {
			return nil, false, issue("reference target is not available")
		}
		ok, err := st.Exists(target, s)
		if err != nil {
			return nil, false, issue("could not verify reference target")
		}
		if !ok {
			return nil, false, issue(fmt.Sprintf("referenced %s %q does not exist", target.Name, s))
		}
		return s, false, nil

	default:
		return nil, false, issue("unsupported field type")
	}
}

// DefaultStoreValue converts a field's declared default into its
// storage-ready value. Datetime defaults are canonicalised at this point
// (not at manifest-parse time); other types are already in their canonical
// Go form from schema.Parse's normalisation.
func DefaultStoreValue(f *schema.Field) any {
	if f.Type == schema.TypeDatetime {
		if s, ok := f.Default.(string); ok {
			if canon, err := store.CanonicalDatetime(s); err == nil {
				return canon
			}
		}
	}
	return f.Default
}

func isJSONNull(raw json.RawMessage) bool {
	return len(raw) == 4 && string(raw) == "null"
}

func numStr(v float64) string {
	if v == float64(int64(v)) {
		return fmt.Sprintf("%d", int64(v))
	}
	return fmt.Sprintf("%g", v)
}
