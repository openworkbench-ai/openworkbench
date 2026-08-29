// Package domain holds the runtime operations every installed app's CRUD
// surface reduces to — create, get, list, update, delete one entity's rows —
// as plain Go functions with no dependency on net/http or any other
// transport. It resolves the app and entity through the registry, enforces
// the entity's declared operation set, applies the shared field-coercion
// rules (coerce.go), and calls the store, returning a structured *OpError a
// transport maps to its own wire shape.
//
// This is the seam the MCP transport (mcpserver/) uses: api/ wraps these
// functions for HTTP, tools/ wraps the *In variants (CreateIn/GetIn/UpdateIn/
// DeleteIn) to run a manifest-declared tool's step sequence atomically
// against one transaction, and mcpserver/ exposes each declared tool as an
// MCP tool over that engine. sandbox/'s function runtime independently proves
// the same underlying pattern (call the store directly, no HTTP in sight).
package domain

import (
	"encoding/json"
	"errors"
	"net/url"

	"pocketknife/registry"
	"pocketknife/schema"
	"pocketknife/store"
)

// ListResult is the outcome of a successful List: the matching rows, the
// total count ignoring limit/offset, and the limit/offset actually applied
// (defaulted and/or clamped from the request).
type ListResult struct {
	Rows   []map[string]any
	Total  int
	Limit  int
	Offset int
}

// resolveEntity looks up the app and entity and checks that op is enabled,
// the same three checks every operation below needs before touching the
// store.
func resolveEntity(reg *registry.Registry, appID, entityName string, op schema.Operation) (*registry.RegisteredApp, *schema.Entity, *OpError) {
	ra, ok := reg.App(appID)
	if !ok {
		return nil, nil, &OpError{Kind: ErrAppNotFound, Message: "no app with id " + appID}
	}
	ent := ra.Schema.Entity(entityName)
	if ent == nil {
		return nil, nil, &OpError{Kind: ErrEntityNotFound, Message: "no entity " + entityName + " in app " + appID}
	}
	if !ent.Allows(op) {
		return nil, nil, &OpError{Kind: ErrOperationDisabled, Message: "operation " + string(op) + " is not enabled for entity " + ent.Name}
	}
	return ra, ent, nil
}

// storeOpError classifies a store-layer error into the sentinel-backed
// OpError kinds every transport needs to distinguish (a conflict is the
// caller's fault; anything else is unexpected).
func storeOpError(err error) *OpError {
	switch {
	case errors.Is(err, store.ErrUnique):
		return &OpError{Kind: ErrUnique, Message: "a row with this value already exists"}
	case errors.Is(err, store.ErrForeignKey):
		return &OpError{Kind: ErrReferenceConflict, Message: "operation violates a reference constraint"}
	default:
		return &OpError{Kind: ErrInternal, Message: err.Error()}
	}
}

func notFoundRow(ent *schema.Entity, id string) *OpError {
	return &OpError{Kind: ErrRowNotFound, Message: "no " + ent.Name + " with id " + id}
}

// coerceFields runs the shared per-declared-field loop used by both Create
// and Update: default/required handling for Create's absent-field case
// (onCreate), coercion for every present field, and null handling. It always
// collects every issue rather than failing on the first one, so a caller
// with several bad fields sees all of them in one round trip — and so a
// possible future caller with different transport-level policies (e.g. a
// sandboxed function reporting only the first issue) can do so by simply
// taking issues[0] rather than needing a different code path here.
//
// rs is the store the coerced values run against — ra.Store for the normal
// HTTP path, or a transaction-scoped store for a caller (e.g. the tools
// engine) composing this call with others atomically.
func coerceFields(rs RowStore, appSchema *schema.App, ent *schema.Entity, body map[string]json.RawMessage, onCreate bool) (map[string]any, []FieldError) {
	values := map[string]any{}
	var issues []FieldError
	for _, f := range ent.Fields {
		raw, present := body[f.Name]
		if !present {
			if onCreate {
				if f.HasDefault {
					values[f.Name] = DefaultStoreValue(f)
				} else if f.Required {
					issues = append(issues, FieldError{Field: f.Name, Message: "is required"})
				}
			}
			// On update, an absent field is left untouched — that's the
			// partial-update contract.
			continue
		}
		val, isNull, ferr := CoerceFieldValue(appSchema, rs, f, raw)
		if ferr != nil {
			issues = append(issues, *ferr)
			continue
		}
		if isNull {
			if f.Required {
				issues = append(issues, FieldError{Field: f.Name, Message: "is required and cannot be null"})
				continue
			}
			values[f.Name] = nil
			continue
		}
		values[f.Name] = val
	}
	return values, issues
}

// CreateIn runs Create's validation and insert logic against an explicit
// store rather than resolving one from the registry. Create is the common
// case (rs = ra.Store); the tools engine is the other caller, running several
// entities' worth of these *In functions against one shared transaction so a
// whole step sequence commits or rolls back together.
func CreateIn(rs RowStore, ra *registry.RegisteredApp, ent *schema.Entity, body map[string]json.RawMessage) (map[string]any, *OpError) {
	values, issues := coerceFields(rs, ra.Schema, ent, body, true)
	if len(issues) > 0 {
		return nil, &OpError{Kind: ErrValidation, Message: "request body failed validation", Issues: issues}
	}

	now := store.NowUTC()
	values["id"] = store.NewID()
	values["created_at"] = now
	values["updated_at"] = now

	row, err := rs.Insert(ent, values)
	if err != nil {
		return nil, storeOpError(err)
	}
	return row, nil
}

// Create validates body against ent's declared fields and inserts a new row,
// with the platform columns (id, created_at, updated_at) set automatically.
func Create(reg *registry.Registry, appID, entityName string, body map[string]json.RawMessage) (map[string]any, *OpError) {
	ra, ent, operr := resolveEntity(reg, appID, entityName, schema.OpCreate)
	if operr != nil {
		return nil, operr
	}
	return CreateIn(ra.Store, ra, ent, body)
}

// GetIn runs Get's read against an explicit store; see CreateIn.
func GetIn(rs RowStore, ent *schema.Entity, id string) (map[string]any, *OpError) {
	row, err := rs.GetByID(ent, id)
	if err != nil {
		return nil, storeOpError(err)
	}
	if row == nil {
		return nil, notFoundRow(ent, id)
	}
	return row, nil
}

// Get returns one row by id.
func Get(reg *registry.Registry, appID, entityName, id string) (map[string]any, *OpError) {
	ra, ent, operr := resolveEntity(reg, appID, entityName, schema.OpRead)
	if operr != nil {
		return nil, operr
	}
	return GetIn(ra.Store, ent, id)
}

// ListIn runs List's read against an explicit store and an already-built
// query; see CreateIn. DefaultListQuery is the query a caller with no query
// string to parse (e.g. a tool's list step) should pass.
func ListIn(rs RowStore, ent *schema.Entity, q store.ListQuery) (*ListResult, *OpError) {
	rows, total, err := rs.List(ent, q)
	if err != nil {
		return nil, storeOpError(err)
	}
	return &ListResult{Rows: rows, Total: total, Limit: q.Limit, Offset: q.Offset}, nil
}

// DefaultListQuery is the filterless, sortless, first-page query the HTTP
// list endpoint defaults to when its query string is empty -- what a tool's
// list step uses too, since a step declares no query parameters of its own.
func DefaultListQuery() store.ListQuery {
	return store.ListQuery{Limit: defaultLimit}
}

// List returns matching rows for the query-string-encoded filter/sort/
// pagination terms described in domain/query.go.
func List(reg *registry.Registry, appID, entityName string, query url.Values) (*ListResult, *OpError) {
	ra, ent, operr := resolveEntity(reg, appID, entityName, schema.OpRead)
	if operr != nil {
		return nil, operr
	}
	q, ferr := parseListQuery(ent, query)
	if ferr != nil {
		return nil, &OpError{Kind: ErrInvalidQuery, Message: ferr.Message, Issues: []FieldError{*ferr}}
	}
	return ListIn(ra.Store, ent, q)
}

// UpdateIn runs Update's validation and write logic against an explicit
// store; see CreateIn.
func UpdateIn(rs RowStore, ra *registry.RegisteredApp, ent *schema.Entity, id string, body map[string]json.RawMessage) (map[string]any, *OpError) {
	existing, err := rs.GetByID(ent, id)
	if err != nil {
		return nil, storeOpError(err)
	}
	if existing == nil {
		return nil, notFoundRow(ent, id)
	}

	values, issues := coerceFields(rs, ra.Schema, ent, body, false)
	if len(issues) > 0 {
		return nil, &OpError{Kind: ErrValidation, Message: "request body failed validation", Issues: issues}
	}
	values["updated_at"] = store.NowUTC()

	row, err := rs.Update(ent, id, values)
	if err != nil {
		return nil, storeOpError(err)
	}
	if row == nil {
		return nil, notFoundRow(ent, id)
	}
	return row, nil
}

// Update applies a partial change: only the fields present in body are
// touched, everything else is left as-is.
func Update(reg *registry.Registry, appID, entityName, id string, body map[string]json.RawMessage) (map[string]any, *OpError) {
	ra, ent, operr := resolveEntity(reg, appID, entityName, schema.OpUpdate)
	if operr != nil {
		return nil, operr
	}
	return UpdateIn(ra.Store, ra, ent, id, body)
}

// DeleteIn runs Delete's logic against an explicit store; see CreateIn.
func DeleteIn(rs RowStore, ent *schema.Entity, id string) (bool, *OpError) {
	deleted, err := rs.Delete(ent, id)
	if err != nil {
		return false, storeOpError(err)
	}
	if !deleted {
		return false, notFoundRow(ent, id)
	}
	return true, nil
}

// Delete removes a row, reporting whether one existed.
func Delete(reg *registry.Registry, appID, entityName, id string) (bool, *OpError) {
	ra, ent, operr := resolveEntity(reg, appID, entityName, schema.OpDelete)
	if operr != nil {
		return false, operr
	}
	return DeleteIn(ra.Store, ent, id)
}
