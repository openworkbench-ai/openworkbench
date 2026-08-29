// Package tools executes a manifest-declared Tool: an ordered, non-branching
// sequence of CRUD calls into an app's own entities, run atomically in one
// database transaction. A tool step only ever calls the same domain
// operations the HTTP API exposes (domain.CreateIn/GetIn/UpdateIn/DeleteIn) —
// a tool has no separate security boundary because it can't do anything a
// request against /apps/{app}/{entity} couldn't already do; it only names and
// sequences those calls. This is the engine mcpserver/ wraps: one declared
// tool becomes one MCP tool, and a call to it runs through Execute.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"pocketknife/domain"
	"pocketknife/registry"
	"pocketknife/schema"
	"pocketknife/store"
)

// Result is the outcome of a successful tool call: the last step's output
// row (the call's headline result) plus every named step's output, keyed by
// the step's declared id, for a caller that wants an intermediate value.
type Result struct {
	Result map[string]any
	Steps  map[string]map[string]any
}

// Execute runs one declared tool (by id or name) against reg: it resolves
// params against the tool's declared parameter list, then runs every step in
// order inside a single transaction — a failure at any step rolls back
// everything earlier steps in this call did, so the tool either fully
// applies or has no effect at all.
func Execute(ctx context.Context, reg *registry.Registry, appID, toolID string, params map[string]json.RawMessage) (*Result, *domain.OpError) {
	ra, ok := reg.App(appID)
	if !ok {
		return nil, &domain.OpError{Kind: domain.ErrAppNotFound, Message: "no app with id " + appID}
	}
	tool := ra.Schema.ToolByID(toolID)
	if tool == nil {
		tool = ra.Schema.Tool(toolID)
	}
	if tool == nil {
		return nil, &domain.OpError{Kind: domain.ErrToolNotFound, Message: "no tool " + toolID + " in app " + appID}
	}

	tx, err := ra.Store.BeginTx(ctx)
	if err != nil {
		return nil, &domain.OpError{Kind: domain.ErrInternal, Message: err.Error()}
	}

	paramValues, issues := resolveParams(ra.Schema, tx, tool, params)
	if len(issues) > 0 {
		tx.Rollback()
		return nil, &domain.OpError{Kind: domain.ErrValidation, Message: "tool params failed validation", Issues: issues}
	}

	stepResults := map[string]map[string]any{}
	var last map[string]any
	for si, step := range tool.Steps {
		ent := ra.Schema.EntityByID(step.Entity) // guaranteed to resolve: validate/semantic.go is the hard gate
		row, operr := runStep(tx, ra, ent, step, paramValues, stepResults)
		if operr != nil {
			tx.Rollback()
			return nil, wrapStepErr(si, step, operr)
		}
		last = row
		if step.ID != "" {
			stepResults[step.ID] = row
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, &domain.OpError{Kind: domain.ErrInternal, Message: err.Error()}
	}
	return &Result{Result: last, Steps: stepResults}, nil
}

// runStep executes one step against tx, resolving its templates first.
func runStep(tx *store.Tx, ra *registry.RegisteredApp, ent *schema.Entity, step *schema.ToolStep, params map[string]any, steps map[string]map[string]any) (map[string]any, *domain.OpError) {
	switch step.Op {
	case schema.OpCreate:
		body, issues := resolveSet(step.Set, params, steps)
		if len(issues) > 0 {
			return nil, &domain.OpError{Kind: domain.ErrValidation, Message: "step failed validation", Issues: issues}
		}
		return domain.CreateIn(tx, ra, ent, body)

	case schema.OpRead:
		id, ferr := resolveID(step.RowID, params, steps)
		if ferr != nil {
			return nil, &domain.OpError{Kind: domain.ErrValidation, Message: "step failed validation", Issues: []domain.FieldError{*ferr}}
		}
		return domain.GetIn(tx, ent, id)

	case schema.OpList:
		filters, issues := resolveFilters(step.Filter, params, steps)
		if len(issues) > 0 {
			return nil, &domain.OpError{Kind: domain.ErrValidation, Message: "step failed validation", Issues: issues}
		}
		q := domain.DefaultListQuery()
		q.Filters = filters
		result, operr := domain.ListIn(tx, ent, q)
		if operr != nil {
			return nil, operr
		}
		return map[string]any{"rows": result.Rows, "total": result.Total}, nil

	case schema.OpUpdate:
		id, ferr := resolveID(step.RowID, params, steps)
		if ferr != nil {
			return nil, &domain.OpError{Kind: domain.ErrValidation, Message: "step failed validation", Issues: []domain.FieldError{*ferr}}
		}
		body, issues := resolveSet(step.Set, params, steps)
		if len(issues) > 0 {
			return nil, &domain.OpError{Kind: domain.ErrValidation, Message: "step failed validation", Issues: issues}
		}
		return domain.UpdateIn(tx, ra, ent, id, body)

	case schema.OpDelete:
		id, ferr := resolveID(step.RowID, params, steps)
		if ferr != nil {
			return nil, &domain.OpError{Kind: domain.ErrValidation, Message: "step failed validation", Issues: []domain.FieldError{*ferr}}
		}
		ok, operr := domain.DeleteIn(tx, ent, id)
		if operr != nil {
			return nil, operr
		}
		return map[string]any{"id": id, "deleted": ok}, nil

	default:
		return nil, &domain.OpError{Kind: domain.ErrInternal, Message: "unsupported step operation " + string(step.Op)}
	}
}

// resolveParams validates the caller-provided params against tool's declared
// parameter list, reusing domain.CoerceFieldValue/DefaultStoreValue exactly —
// a tool param is declared with the same shape as an entity field, so the
// same coercion, default and (for a reference-typed param) existence-check
// rules apply unchanged.
func resolveParams(app *schema.App, rs domain.RowStore, tool *schema.Tool, provided map[string]json.RawMessage) (map[string]any, []domain.FieldError) {
	var issues []domain.FieldError
	for name := range provided {
		if tool.Param(name) == nil {
			issues = append(issues, domain.FieldError{Field: name, Message: "is not a declared parameter of this tool"})
		}
	}

	values := map[string]any{}
	for _, p := range tool.Params {
		raw, present := provided[p.Name]
		if !present {
			switch {
			case p.HasDefault:
				values[p.Name] = domain.DefaultStoreValue(p)
			case p.Required:
				issues = append(issues, domain.FieldError{Field: p.Name, Message: "is required"})
			default:
				// Optional, no default, not provided: resolves to null for any
				// step that references it — the same as an explicit null would.
				values[p.Name] = nil
			}
			continue
		}
		val, isNull, ferr := domain.CoerceFieldValue(app, rs, p, raw)
		if ferr != nil {
			issues = append(issues, *ferr)
			continue
		}
		if isNull {
			if p.Required {
				issues = append(issues, domain.FieldError{Field: p.Name, Message: "is required and cannot be null"})
				continue
			}
			values[p.Name] = nil
			continue
		}
		values[p.Name] = val
	}
	return values, issues
}

// resolveSet builds a step's request body by resolving every template value
// in set against the call's params and prior steps' results.
func resolveSet(set map[string]*schema.StepValue, params map[string]any, steps map[string]map[string]any) (map[string]json.RawMessage, []domain.FieldError) {
	body := map[string]json.RawMessage{}
	var issues []domain.FieldError
	for field, sv := range set {
		raw, err := resolveValue(sv, params, steps)
		if err != nil {
			issues = append(issues, domain.FieldError{Field: field, Message: err.Error()})
			continue
		}
		body[field] = raw
	}
	return body, issues
}

// resolveFilters builds a list step's equality filters (AND-combined) from
// its declared filter templates, resolved against the call's params and
// prior steps' results exactly like resolveSet.
func resolveFilters(filter map[string]*schema.StepValue, params map[string]any, steps map[string]map[string]any) ([]store.Filter, []domain.FieldError) {
	var filters []store.Filter
	var issues []domain.FieldError
	for field, sv := range filter {
		raw, err := resolveValue(sv, params, steps)
		if err != nil {
			issues = append(issues, domain.FieldError{Field: field, Message: err.Error()})
			continue
		}
		var val any
		if err := json.Unmarshal(raw, &val); err != nil {
			issues = append(issues, domain.FieldError{Field: field, Message: "must resolve to a value"})
			continue
		}
		filters = append(filters, store.Filter{Column: field, Operator: "=", Value: val})
	}
	return filters, issues
}

// resolveID resolves a rowId template to a plain string.
func resolveID(sv *schema.StepValue, params map[string]any, steps map[string]map[string]any) (string, *domain.FieldError) {
	raw, err := resolveValue(sv, params, steps)
	if err != nil {
		return "", &domain.FieldError{Field: "rowId", Message: err.Error()}
	}
	var id string
	if err := json.Unmarshal(raw, &id); err != nil {
		return "", &domain.FieldError{Field: "rowId", Message: "must resolve to a string id"}
	}
	return id, nil
}

// resolveValue resolves one StepValue (see schema.StepValue) against the
// call's params and the results of steps that have already run.
func resolveValue(sv *schema.StepValue, params map[string]any, steps map[string]map[string]any) (json.RawMessage, error) {
	if sv == nil {
		return json.RawMessage("null"), nil
	}
	if sv.Ref == "" {
		return sv.Literal, nil
	}
	root, rest, _ := strings.Cut(sv.Ref, ".")
	switch root {
	case "params":
		v, ok := params[rest]
		if !ok {
			return nil, fmt.Errorf("param %q was not provided", rest)
		}
		return json.Marshal(v)
	case "steps":
		stepID, field, _ := strings.Cut(rest, ".")
		row, ok := steps[stepID]
		if !ok {
			return nil, fmt.Errorf("step %q has not run", stepID)
		}
		v, ok := row[field]
		if !ok {
			return nil, fmt.Errorf("step %q has no field %q", stepID, field)
		}
		return json.Marshal(v)
	default:
		return nil, fmt.Errorf("bad reference %q", sv.Ref)
	}
}

// wrapStepErr adds the failing step's identity to operr's message, so a
// multi-step tool's error tells the caller which step in the sequence broke.
func wrapStepErr(index int, step *schema.ToolStep, operr *domain.OpError) *domain.OpError {
	label := step.ID
	if label == "" {
		label = fmt.Sprintf("#%d", index)
	}
	wrapped := *operr
	wrapped.Message = fmt.Sprintf("step %s (%s %s): %s", label, step.Op, step.Entity, operr.Message)
	return &wrapped
}
