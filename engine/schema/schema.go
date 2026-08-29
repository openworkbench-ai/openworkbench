// Package schema is the typed, in-memory representation that a manifest parses
// into. It holds no behaviour beyond parsing and small lookup helpers; the
// validator, materializer, store and API all read from this model.
//
// The model preserves the manifest's stable IDs as the identity of every app,
// entity and field. Names are mutable labels used as SQL identifiers and JSON
// keys; IDs never change. (A future migration engine will diff schemas by ID.)
package schema

import "encoding/json"

// FieldType is the closed set of field types supported in v1. Any other value
// is a validation error — there is no escape hatch.
type FieldType string

const (
	TypeText      FieldType = "text"
	TypeInteger   FieldType = "integer"
	TypeReal      FieldType = "real"
	TypeBoolean   FieldType = "boolean"
	TypeDatetime  FieldType = "datetime"
	TypeEnum      FieldType = "enum"
	TypeReference FieldType = "reference"
)

// Operation names the four CRUD operations an entity may expose, plus
// OpList: a fifth value valid only for a ToolStep, never for an entity's own
// declared operations set. Listing many rows shares an entity's OpRead
// permission (the same way the HTTP list endpoint does) rather than needing
// its own entity-level grant.
type Operation string

const (
	OpCreate Operation = "create"
	OpRead   Operation = "read"
	OpUpdate Operation = "update"
	OpDelete Operation = "delete"
	OpList   Operation = "list"
)

// AllOperations is the default operation set for an entity that does not
// declare one.
var AllOperations = []Operation{OpCreate, OpRead, OpUpdate, OpDelete}

// OnDelete actions for reference fields.
const (
	OnDeleteSetNull  = "set_null"
	OnDeleteRestrict = "restrict"
	OnDeleteCascade  = "cascade"
)

// ReservedNames are the platform-managed column names. A manifest must never
// declare a field with one of these names.
var ReservedNames = []string{"id", "created_at", "updated_at"}

// App is the root of the schema model.
type App struct {
	ID       string
	Name     string
	Emoji    string
	Color    string
	Version  int
	Entities []*Entity
	// Frontend points at this version's pre-built static bundle, or nil if the
	// app declares no frontend (API-only).
	Frontend *Frontend
	// Functions are this app's sandboxed server-side functions, or nil if the
	// app declares none.
	Functions []*Function
	// Tools are this app's declarative, manifest-defined MCP tools, or nil if
	// the app declares none.
	Tools []*Tool
}

// Frontend names a pre-built static asset bundle for this manifest version.
// Pocketknife never bundles on-box in this phase: Dist must already contain
// the built HTML/JS/CSS output, relative to the app's directory.
type Frontend struct {
	// Dist is the path, relative to the app directory, of the built static
	// asset directory (e.g. "frontend/dist").
	Dist string
	// Entry is the file within Dist served for the root and for any path that
	// does not match a real asset (SPA fallback). Defaults to "index.html".
	Entry string
}

// Function is one declared sandboxed server-side function: a pre-compiled
// WebAssembly module plus the capabilities the sandbox grants it. Pocketknife
// never compiles functions on-box — Entry must already name a built .wasm
// module, relative to the app's directory, mirroring how Frontend.Dist must
// already be a built static bundle. The manifest only ever declares
// capabilities; the sandbox is what actually enforces them.
type Function struct {
	ID           string
	Name         string
	Entry        string
	Capabilities *Capabilities
}

// Capabilities is the closed set of host interfaces a function may use. There
// is no escape hatch: the sandbox grants exactly these and nothing else,
// regardless of what the function's code attempts.
type Capabilities struct {
	// Data grants access to specific entities, each restricted to a subset of
	// that entity's own enabled operations.
	Data []DataScope
	// Network is the exact-match allow-listed set of hostnames a function may
	// reach. There is no wildcard matching and no general fetch.
	Network []string
	// Model grants access to the model broker. The function never receives the
	// underlying provider token.
	Model bool
}

// DataScope grants a function access to one entity, restricted to the
// declared operations on it.
type DataScope struct {
	// Entity is the target entity's stable ID.
	Entity     string
	Operations []Operation
}

// Allows reports whether the scope for the given entity ID permits op. It
// returns false if the entity has no scope declared at all.
func (c *Capabilities) Allows(entityID string, op Operation) bool {
	if c == nil {
		return false
	}
	for _, ds := range c.Data {
		if ds.Entity != entityID {
			continue
		}
		for _, o := range ds.Operations {
			if o == op {
				return true
			}
		}
		return false
	}
	return false
}

// AllowsDomain reports whether host is in the function's exact-match network
// allow-list.
func (c *Capabilities) AllowsDomain(host string) bool {
	if c == nil {
		return false
	}
	for _, d := range c.Network {
		if d == host {
			return true
		}
	}
	return false
}

// Tool is a named, manifest-declared MCP tool: an ordered, non-branching
// sequence of CRUD calls into this app's own entities, run atomically as one
// transaction (see the tools package). A tool has no separate execution
// boundary the way a Function does — it can only call domain's existing
// Create/Read/Update/Delete on entities and operations the manifest already
// allows, so it can't do anything a direct request against
// /apps/{app}/{entity} couldn't already do; it only names and sequences
// those calls for an MCP client. Arbitrary logic still belongs in Function.
type Tool struct {
	ID          string
	Name        string
	Description string
	// Params are the tool's call-time inputs, declared with the same shape
	// entity fields use (type/required/default/constraints), so the existing
	// field-coercion machinery (CoerceFieldValue) validates them unchanged and
	// an MCP client gets a real JSON Schema for its call arguments.
	Params []*Field
	Steps  []*ToolStep
}

// Tool returns the tool with the given name, or nil.
func (a *App) Tool(name string) *Tool {
	for _, t := range a.Tools {
		if t.Name == name {
			return t
		}
	}
	return nil
}

// ToolByID returns the tool with the given stable ID, or nil.
func (a *App) ToolByID(id string) *Tool {
	for _, t := range a.Tools {
		if t.ID == id {
			return t
		}
	}
	return nil
}

// Param returns the tool's declared parameter with the given name, or nil.
func (t *Tool) Param(name string) *Field {
	for _, p := range t.Params {
		if p.Name == name {
			return p
		}
	}
	return nil
}

// ToolStep is one CRUD call in a tool's sequence, run in order. RowID and Set
// values are templates (see StepValue), resolved against the call's params
// and the results of earlier steps in the same tool before the step runs.
type ToolStep struct {
	// ID names this step's result for later steps to reference via a
	// "steps.<id>.<field>" StepValue.Ref. Optional; only needed if referenced.
	ID string
	// Op is the CRUD operation this step performs; must be one the target
	// Entity itself allows.
	Op Operation
	// Entity is the target entity's stable ID.
	Entity string
	// RowID resolves to the row id this step acts on. Required for read,
	// update and delete; must be nil for create.
	RowID *StepValue
	// Set maps a field name on Entity to a template value. Used for create's
	// initial values and update's changed fields; unused for read and delete.
	Set map[string]*StepValue
	// Filter maps a field name on Entity to a template value that field must
	// equal, AND-combined across entries. Only valid for op "list"; unused
	// for every other op.
	Filter map[string]*StepValue
}

// StepValue is a template resolved at call time inside a ToolStep. A Ref of
// "params.<name>" resolves against the call's parameters; a Ref of
// "steps.<id>.<field>" resolves against an earlier step's result row. A blank
// Ref means Literal is a literal JSON value (of any JSON type), taken as-is.
type StepValue struct {
	Ref     string
	Literal json.RawMessage
}

// Entity is a single table's worth of schema.
type Entity struct {
	ID         string
	Name       string
	Operations []Operation
	Fields     []*Field
}

// Field is one declared column. Constraint members are only meaningful for the
// field types that allow them (see the manifest schema); the validator
// guarantees that invariant before a Field reaches the rest of the system.
type Field struct {
	ID       string
	Name     string
	Type     FieldType
	Required bool
	Unique   bool

	// HasDefault distinguishes "no default" from "default is the zero value".
	HasDefault bool
	// Default holds the normalised default value: string for text/datetime/enum,
	// int64 for integer, float64 for real, bool for boolean.
	Default any

	// Min/Max bound either length (text) or value (integer/real). nil means
	// unconstrained.
	Min *float64
	Max *float64

	// Values is the allowed set for an enum field.
	Values []string

	// Target is the referenced entity's stable ID; OnDelete the FK action.
	Target   string
	OnDelete string
}

// Field returns the field with the given name, or nil.
func (e *Entity) Field(name string) *Field {
	for _, f := range e.Fields {
		if f.Name == name {
			return f
		}
	}
	return nil
}

// FieldByID returns the field with the given stable ID, or nil. The migration
// engine matches fields across versions by ID (a rename keeps the ID), so it
// resolves fields this way rather than by mutable name.
func (e *Entity) FieldByID(id string) *Field {
	for _, f := range e.Fields {
		if f.ID == id {
			return f
		}
	}
	return nil
}

// Allows reports whether the entity exposes the given operation.
func (e *Entity) Allows(op Operation) bool {
	for _, o := range e.Operations {
		if o == op {
			return true
		}
	}
	return false
}

// Function returns the function with the given name, or nil.
func (a *App) Function(name string) *Function {
	for _, f := range a.Functions {
		if f.Name == name {
			return f
		}
	}
	return nil
}

// FunctionByID returns the function with the given stable ID, or nil.
func (a *App) FunctionByID(id string) *Function {
	for _, f := range a.Functions {
		if f.ID == id {
			return f
		}
	}
	return nil
}

// Entity returns the entity with the given name, or nil.
func (a *App) Entity(name string) *Entity {
	for _, e := range a.Entities {
		if e.Name == name {
			return e
		}
	}
	return nil
}

// EntityByID returns the entity with the given stable ID, or nil.
func (a *App) EntityByID(id string) *Entity {
	for _, e := range a.Entities {
		if e.ID == id {
			return e
		}
	}
	return nil
}
