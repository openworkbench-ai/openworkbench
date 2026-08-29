// Package validate is the hard gate of the runtime. A manifest that does not
// pass validation is never parsed into a served schema, never materialized and
// never registered. Validation has two layers:
//
//  1. Structural — the manifest is checked against the canonical
//     manifest.schema.json (JSON Schema). This enforces required keys, the
//     closed type set, per-type constraint keys, name patterns and the
//     rejection of unknown keys.
//  2. Semantic — checks that JSON Schema cannot express: stable-ID uniqueness,
//     sibling-name uniqueness, reserved-name avoidance, defaults that satisfy
//     their own constraints, enum defaults drawn from the value set, and
//     references that resolve to an entity in the same manifest.
//
// Validate always returns a flat, structured list of errors (path + code +
// message), never a single opaque string.
package validate

import (
	"fmt"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"

	pocketknife "pocketknife"
	"pocketknife/schema"
)

// Error is one structured validation failure.
type Error struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e Error) String() string {
	p := e.Path
	if p == "" {
		p = "(root)"
	}
	return fmt.Sprintf("%s [%s]: %s", p, e.Code, e.Message)
}

// Errors is a list of validation failures.
type Errors []Error

func (es Errors) Error() string {
	parts := make([]string, len(es))
	for i, e := range es {
		parts[i] = e.String()
	}
	return strings.Join(parts, "; ")
}

// compiledSchema is the parsed manifest JSON Schema. It is compiled once.
var compiledSchema = mustCompileManifestSchema()

func mustCompileManifestSchema() *jsonschema.Schema {
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(string(pocketknife.ManifestSchemaJSON)))
	if err != nil {
		panic(fmt.Sprintf("embedded manifest schema is not valid JSON: %v", err))
	}
	c := jsonschema.NewCompiler()
	const url = "https://pocketknife.local/manifest.schema.json"
	if err := c.AddResource(url, doc); err != nil {
		panic(fmt.Sprintf("cannot add manifest schema resource: %v", err))
	}
	sch, err := c.Compile(url)
	if err != nil {
		panic(fmt.Sprintf("cannot compile manifest schema: %v", err))
	}
	return sch
}

// Manifest validates raw manifest bytes. On success it returns the parsed
// schema model and a nil error list. On failure it returns a nil model and a
// non-empty, structured error list. The model is only ever returned when the
// manifest is fully valid, so callers can treat a non-nil model as "safe to
// materialize and serve".
func Manifest(data []byte) (*schema.App, Errors) {
	// Layer 1: structural.
	inst, err := jsonschema.UnmarshalJSON(strings.NewReader(string(data)))
	if err != nil {
		return nil, Errors{{Path: "", Code: "invalid_json", Message: err.Error()}}
	}
	if err := compiledSchema.Validate(inst); err != nil {
		ve, ok := err.(*jsonschema.ValidationError)
		if !ok {
			return nil, Errors{{Path: "", Code: "structural", Message: err.Error()}}
		}
		return nil, structuralErrors(ve)
	}

	// The document is structurally sound; parse it into the typed model.
	app, perr := schema.Parse(data)
	if perr != nil {
		return nil, Errors{{Path: "", Code: "parse", Message: perr.Error()}}
	}

	// Layer 2: semantic.
	if errs := semantic(app); len(errs) > 0 {
		return nil, errs
	}
	return app, nil
}

// structuralErrors flattens a JSON Schema validation error tree into our
// structured form using the basic output, which lists each leaf failure with
// its instance location.
func structuralErrors(ve *jsonschema.ValidationError) Errors {
	out := ve.BasicOutput()
	var errs Errors
	collectOutput(out, &errs)
	if len(errs) == 0 {
		// Fallback: never return an empty list for a real failure.
		errs = append(errs, Error{Path: "", Code: "structural", Message: ve.Error()})
	}
	return errs
}

func collectOutput(u *jsonschema.OutputUnit, errs *Errors) {
	if u == nil {
		return
	}
	if u.Error != nil {
		*errs = append(*errs, Error{
			Path:    instancePath(u.InstanceLocation),
			Code:    "structural",
			Message: u.Error.String(),
		})
	}
	for i := range u.Errors {
		collectOutput(&u.Errors[i], errs)
	}
}

// instancePath normalises a JSON-Pointer-ish instance location to a leading
// slash form, e.g. "/entities/0/fields/1/type".
func instancePath(loc string) string {
	if loc == "" {
		return ""
	}
	if !strings.HasPrefix(loc, "/") {
		return "/" + loc
	}
	return loc
}
