package validate

import (
	"fmt"
	"strings"

	"pocketknife/schema"
)

// semantic runs the checks that JSON Schema cannot express. It walks the parsed
// model and accumulates structured errors; it never stops at the first problem,
// so a caller sees every issue at once.
func semantic(app *schema.App) Errors {
	var errs Errors

	entityIDs := map[string]bool{}
	entityNames := map[string]bool{}

	for ei, ent := range app.Entities {
		epath := fmt.Sprintf("/entities/%d", ei)

		if entityIDs[ent.ID] {
			errs = append(errs, Error{epath + "/id", "duplicate_id", fmt.Sprintf("entity id %q is not unique", ent.ID)})
		}
		entityIDs[ent.ID] = true

		if entityNames[ent.Name] {
			errs = append(errs, Error{epath + "/name", "duplicate_name", fmt.Sprintf("entity name %q is not unique", ent.Name)})
		}
		entityNames[ent.Name] = true

		fieldIDs := map[string]bool{}
		fieldNames := map[string]bool{}

		for fi, f := range ent.Fields {
			fpath := fmt.Sprintf("%s/fields/%d", epath, fi)

			if fieldIDs[f.ID] {
				errs = append(errs, Error{fpath + "/id", "duplicate_id", fmt.Sprintf("field id %q is not unique within entity %q", f.ID, ent.Name)})
			}
			fieldIDs[f.ID] = true

			// A field id becomes a physical column name (D1), so it must not
			// collide with a platform-managed column.
			if isReserved(f.ID) {
				errs = append(errs, Error{fpath + "/id", "reserved_id", fmt.Sprintf("field id %q is reserved by the platform", f.ID)})
			}

			if fieldNames[f.Name] {
				errs = append(errs, Error{fpath + "/name", "duplicate_name", fmt.Sprintf("field name %q is not unique within entity %q", f.Name, ent.Name)})
			}
			fieldNames[f.Name] = true

			if isReserved(f.Name) {
				errs = append(errs, Error{fpath + "/name", "reserved_name", fmt.Sprintf("field name %q is reserved by the platform", f.Name)})
			}

			errs = append(errs, validateField(fpath, app, ent, f)...)
		}
	}

	fnIDs := map[string]bool{}
	fnNames := map[string]bool{}
	for fi, fn := range app.Functions {
		fpath := fmt.Sprintf("/functions/%d", fi)

		if fnIDs[fn.ID] {
			errs = append(errs, Error{fpath + "/id", "duplicate_id", fmt.Sprintf("function id %q is not unique", fn.ID)})
		}
		fnIDs[fn.ID] = true

		if fnNames[fn.Name] {
			errs = append(errs, Error{fpath + "/name", "duplicate_name", fmt.Sprintf("function name %q is not unique", fn.Name)})
		}
		fnNames[fn.Name] = true

		errs = append(errs, validateCapabilities(fpath+"/capabilities", app, fn)...)
	}

	toolIDs := map[string]bool{}
	toolNames := map[string]bool{}
	for ti, tool := range app.Tools {
		tpath := fmt.Sprintf("/tools/%d", ti)

		if toolIDs[tool.ID] {
			errs = append(errs, Error{tpath + "/id", "duplicate_id", fmt.Sprintf("tool id %q is not unique", tool.ID)})
		}
		toolIDs[tool.ID] = true

		if toolNames[tool.Name] {
			errs = append(errs, Error{tpath + "/name", "duplicate_name", fmt.Sprintf("tool name %q is not unique", tool.Name)})
		}
		toolNames[tool.Name] = true

		errs = append(errs, validateTool(tpath, app, tool)...)
	}
	return errs
}

// validateTool checks a tool's params (the same per-field rules entity
// fields get) and its step sequence: every step's entity and operation must
// resolve to something the manifest actually allows, a step's rowId/set
// requirements must match its op, every field a step writes must exist on
// its target entity, and every "$params."/"$steps." reference must resolve
// to a param declared on this tool or an earlier step in this same tool (no
// forward references — a tool's steps form a DAG with no cycles by
// construction, since a step may only ever reference something that ran
// before it).
func validateTool(path string, app *schema.App, tool *schema.Tool) Errors {
	var errs Errors

	paramNames := map[string]bool{}
	for pi, p := range tool.Params {
		ppath := fmt.Sprintf("%s/params/%d", path, pi)
		if paramNames[p.Name] {
			errs = append(errs, Error{ppath + "/name", "duplicate_name", fmt.Sprintf("param name %q is not unique in tool %q", p.Name, tool.Name)})
		}
		paramNames[p.Name] = true
		errs = append(errs, validateField(ppath, app, nil, p)...)
	}

	if len(tool.Steps) == 0 {
		errs = append(errs, Error{path + "/steps", "empty_steps", fmt.Sprintf("tool %q must declare at least one step", tool.Name)})
	}

	stepIDs := map[string]bool{}
	for si, step := range tool.Steps {
		spath := fmt.Sprintf("%s/steps/%d", path, si)

		ent := app.EntityByID(step.Entity)
		if ent == nil {
			errs = append(errs, Error{spath + "/entity", "unresolved_reference", fmt.Sprintf("step entity %q does not resolve to an entity in this manifest", step.Entity)})
		} else {
			// list shares an entity's read permission -- entities never
			// declare "list" itself in their own operations set.
			requiredOp := step.Op
			if step.Op == schema.OpList {
				requiredOp = schema.OpRead
			}
			if !ent.Allows(requiredOp) {
				errs = append(errs, Error{spath + "/op", "scope_exceeds_entity", fmt.Sprintf("tool %q step calls %q on entity %q, which the entity itself does not allow", tool.Name, step.Op, ent.Name)})
			}
		}

		switch step.Op {
		case schema.OpCreate:
			if step.RowID != nil {
				errs = append(errs, Error{spath + "/rowId", "unexpected_field", "create steps must not declare rowId"})
			}
		case schema.OpList:
			if step.RowID != nil {
				errs = append(errs, Error{spath + "/rowId", "unexpected_field", "list steps must not declare rowId"})
			}
		case schema.OpRead, schema.OpUpdate, schema.OpDelete:
			if step.RowID == nil {
				errs = append(errs, Error{spath + "/rowId", "missing_field", fmt.Sprintf("%q steps require rowId", step.Op)})
			}
		}
		if (step.Op == schema.OpRead || step.Op == schema.OpDelete || step.Op == schema.OpList) && len(step.Set) > 0 {
			errs = append(errs, Error{spath + "/set", "unexpected_field", fmt.Sprintf("%q steps must not declare set", step.Op)})
		}
		if step.Op != schema.OpList && len(step.Filter) > 0 {
			errs = append(errs, Error{spath + "/filter", "unexpected_field", fmt.Sprintf("%q steps must not declare filter", step.Op)})
		}

		if ent != nil {
			for fname := range step.Set {
				if isReserved(fname) {
					errs = append(errs, Error{spath + "/set/" + fname, "reserved_name", fmt.Sprintf("field name %q is reserved by the platform", fname)})
					continue
				}
				if ent.Field(fname) == nil {
					errs = append(errs, Error{spath + "/set/" + fname, "unresolved_reference", fmt.Sprintf("field %q does not exist on entity %q", fname, ent.Name)})
				}
			}
			for fname := range step.Filter {
				if ent.Field(fname) == nil && !isReserved(fname) {
					errs = append(errs, Error{spath + "/filter/" + fname, "unresolved_reference", fmt.Sprintf("field %q does not exist on entity %q", fname, ent.Name)})
				}
			}
		}

		checkRef := func(subpath string, sv *schema.StepValue) {
			if sv == nil || sv.Ref == "" {
				return
			}
			root, rest, _ := strings.Cut(sv.Ref, ".")
			switch root {
			case "params":
				if !paramNames[rest] {
					errs = append(errs, Error{subpath, "unresolved_reference", fmt.Sprintf("references undeclared param %q", sv.Ref)})
				}
			case "steps":
				stepID, _, _ := strings.Cut(rest, ".")
				if stepID == "" || !stepIDs[stepID] {
					errs = append(errs, Error{subpath, "unresolved_reference", fmt.Sprintf("references an undeclared or not-yet-run step %q", sv.Ref)})
				}
			default:
				errs = append(errs, Error{subpath, "bad_reference", fmt.Sprintf("unknown reference root %q (must be params or steps)", root)})
			}
		}
		checkRef(spath+"/rowId", step.RowID)
		for fname, sv := range step.Set {
			checkRef(spath+"/set/"+fname, sv)
		}
		for fname, sv := range step.Filter {
			checkRef(spath+"/filter/"+fname, sv)
		}

		if step.ID != "" {
			if stepIDs[step.ID] {
				errs = append(errs, Error{spath + "/id", "duplicate_id", fmt.Sprintf("step id %q is not unique in tool %q", step.ID, tool.Name)})
			}
			stepIDs[step.ID] = true
		}
	}
	return errs
}

// validateCapabilities checks that every declared data scope resolves to a
// real entity in this manifest, is not repeated, and never requests an
// operation the entity itself does not allow — a scope the sandbox could
// never actually exercise is a manifest authoring mistake, not a runtime
// concern.
func validateCapabilities(path string, app *schema.App, fn *schema.Function) Errors {
	var errs Errors
	seenEntities := map[string]bool{}

	for di, ds := range fn.Capabilities.Data {
		dpath := fmt.Sprintf("%s/data/%d", path, di)

		if seenEntities[ds.Entity] {
			errs = append(errs, Error{dpath + "/entity", "duplicate_data_scope", fmt.Sprintf("entity %q is scoped more than once in function %q", ds.Entity, fn.Name)})
		}
		seenEntities[ds.Entity] = true

		ent := app.EntityByID(ds.Entity)
		if ent == nil {
			errs = append(errs, Error{dpath + "/entity", "unresolved_reference", fmt.Sprintf("data scope entity %q does not resolve to an entity in this manifest", ds.Entity)})
			continue
		}
		for _, op := range ds.Operations {
			if !ent.Allows(op) {
				errs = append(errs, Error{dpath + "/operations", "scope_exceeds_entity", fmt.Sprintf("function %q requests %q on entity %q, which the entity itself does not allow", fn.Name, op, ent.Name)})
			}
		}
	}

	seenDomains := map[string]bool{}
	for ni, d := range fn.Capabilities.Network {
		if seenDomains[d] {
			errs = append(errs, Error{fmt.Sprintf("%s/network/%d", path, ni), "duplicate_domain", fmt.Sprintf("domain %q is repeated", d)})
		}
		seenDomains[d] = true
	}
	return errs
}

func isReserved(name string) bool {
	for _, r := range schema.ReservedNames {
		if name == r {
			return true
		}
	}
	return false
}

// validateField checks min/max ordering, reference resolution, enum value
// integrity, and that any default satisfies the field's own constraints.
func validateField(path string, app *schema.App, ent *schema.Entity, f *schema.Field) Errors {
	var errs Errors

	if f.Min != nil && f.Max != nil && *f.Min > *f.Max {
		errs = append(errs, Error{path, "bad_bounds", fmt.Sprintf("min (%v) is greater than max (%v)", *f.Min, *f.Max)})
	}

	switch f.Type {
	case schema.TypeReference:
		if app.EntityByID(f.Target) == nil {
			errs = append(errs, Error{path + "/target", "unresolved_reference", fmt.Sprintf("reference target %q does not resolve to an entity in this manifest", f.Target)})
		}
	case schema.TypeEnum:
		seen := map[string]bool{}
		for _, v := range f.Values {
			if seen[v] {
				errs = append(errs, Error{path + "/values", "duplicate_enum_value", fmt.Sprintf("enum value %q is repeated", v)})
			}
			seen[v] = true
		}
	}

	if f.HasDefault {
		errs = append(errs, validateDefault(path+"/default", f)...)
	}
	return errs
}

// validateDefault confirms a declared default would itself pass field
// validation: enum membership, length bounds (text) and value bounds
// (integer/real).
func validateDefault(path string, f *schema.Field) Errors {
	var errs Errors
	switch f.Type {
	case schema.TypeText:
		s, ok := f.Default.(string)
		if !ok {
			return Errors{{path, "bad_default", "default must be a string"}}
		}
		n := float64(len([]rune(s)))
		if f.Min != nil && n < *f.Min {
			errs = append(errs, Error{path, "bad_default", fmt.Sprintf("default length %d is below min %v", len([]rune(s)), *f.Min)})
		}
		if f.Max != nil && n > *f.Max {
			errs = append(errs, Error{path, "bad_default", fmt.Sprintf("default length %d exceeds max %v", len([]rune(s)), *f.Max)})
		}
	case schema.TypeInteger:
		n, ok := f.Default.(int64)
		if !ok {
			return Errors{{path, "bad_default", "default must be an integer"}}
		}
		if f.Min != nil && float64(n) < *f.Min {
			errs = append(errs, Error{path, "bad_default", fmt.Sprintf("default %d is below min %v", n, *f.Min)})
		}
		if f.Max != nil && float64(n) > *f.Max {
			errs = append(errs, Error{path, "bad_default", fmt.Sprintf("default %d exceeds max %v", n, *f.Max)})
		}
	case schema.TypeReal:
		n, ok := f.Default.(float64)
		if !ok {
			return Errors{{path, "bad_default", "default must be a number"}}
		}
		if f.Min != nil && n < *f.Min {
			errs = append(errs, Error{path, "bad_default", fmt.Sprintf("default %v is below min %v", n, *f.Min)})
		}
		if f.Max != nil && n > *f.Max {
			errs = append(errs, Error{path, "bad_default", fmt.Sprintf("default %v exceeds max %v", n, *f.Max)})
		}
	case schema.TypeEnum:
		s, ok := f.Default.(string)
		if !ok {
			return Errors{{path, "bad_default", "default must be a string"}}
		}
		found := false
		for _, v := range f.Values {
			if v == s {
				found = true
				break
			}
		}
		if !found {
			errs = append(errs, Error{path, "bad_default", fmt.Sprintf("enum default %q is not one of the declared values", s)})
		}
	}
	return errs
}
