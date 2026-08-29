package domain

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"pocketknife/schema"
	"pocketknife/store"
)

const (
	defaultLimit = 50
	maxLimit     = 200
)

// operatorSQL maps the small, fixed set of v1 filter operators to SQL.
var operatorSQL = map[string]string{
	"eq":   "=",
	"ne":   "!=",
	"gt":   ">",
	"gte":  ">=",
	"lt":   "<",
	"lte":  "<=",
	"like": "LIKE",
}

// parseListQuery turns the curl-friendly, AND-combined query string into a
// store.ListQuery. Syntax (v1, intentionally minimal — no OR, nesting or joins):
//
//	filter=<field>:<op>:<value>   (repeatable, AND-combined)
//	sort=<field> | sort=-<field>  (repeatable)
//	limit=<n>  offset=<n>
func parseListQuery(ent *schema.Entity, values url.Values) (store.ListQuery, *FieldError) {
	q := store.ListQuery{Limit: defaultLimit, Offset: 0}

	for _, raw := range values["filter"] {
		parts := strings.SplitN(raw, ":", 3)
		if len(parts) != 3 {
			return q, &FieldError{Field: "filter", Message: fmt.Sprintf("malformed filter %q, expected field:op:value", raw)}
		}
		field, op, valStr := parts[0], parts[1], parts[2]

		sqlOp, ok := operatorSQL[op]
		if !ok {
			return q, &FieldError{Field: "filter", Message: fmt.Sprintf("unknown operator %q", op)}
		}
		colType, ok := resolveColumn(ent, field)
		if !ok {
			return q, &FieldError{Field: "filter", Message: fmt.Sprintf("unknown field %q", field)}
		}
		val, err := coerceFilterValue(colType, op, valStr)
		if err != nil {
			return q, &FieldError{Field: "filter", Message: err.Error()}
		}
		q.Filters = append(q.Filters, store.Filter{Column: field, Operator: sqlOp, Value: val})
	}

	for _, raw := range values["sort"] {
		desc := false
		field := raw
		if strings.HasPrefix(raw, "-") {
			desc = true
			field = raw[1:]
		}
		if _, ok := resolveColumn(ent, field); !ok {
			return q, &FieldError{Field: "sort", Message: fmt.Sprintf("unknown field %q", field)}
		}
		q.Sorts = append(q.Sorts, store.Sort{Column: field, Desc: desc})
	}

	if raw := values.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			return q, &FieldError{Field: "limit", Message: "must be a non-negative integer"}
		}
		if n > maxLimit {
			n = maxLimit
		}
		q.Limit = n
	}
	if raw := values.Get("offset"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			return q, &FieldError{Field: "offset", Message: "must be a non-negative integer"}
		}
		q.Offset = n
	}

	return q, nil
}

// resolveColumn maps a queryable name to the type used to coerce its values.
// Declared fields use their own type; the platform columns are queryable too
// (id as text, created_at/updated_at as datetime) so sort=-created_at works.
func resolveColumn(ent *schema.Entity, name string) (schema.FieldType, bool) {
	if f := ent.Field(name); f != nil {
		return f.Type, true
	}
	switch name {
	case "id":
		return schema.TypeText, true
	case "created_at", "updated_at":
		return schema.TypeDatetime, true
	}
	return "", false
}

// coerceFilterValue converts a raw string filter value into the typed value the
// column expects. LIKE always compares as text.
func coerceFilterValue(t schema.FieldType, op, s string) (any, error) {
	if op == "like" {
		return s, nil
	}
	switch t {
	case schema.TypeInteger:
		i, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("filter value %q must be an integer", s)
		}
		return i, nil
	case schema.TypeReal:
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return nil, fmt.Errorf("filter value %q must be a number", s)
		}
		return f, nil
	case schema.TypeBoolean:
		switch s {
		case "true", "1":
			return true, nil
		case "false", "0":
			return false, nil
		}
		return nil, fmt.Errorf("filter value %q must be a boolean", s)
	case schema.TypeDatetime:
		return store.CanonicalDatetime(s)
	default: // text, enum, reference
		return s, nil
	}
}
