package schema

import (
	"encoding/json"
	"fmt"
	"strings"
)

// raw* mirror the manifest JSON shape. They are intentionally permissive: the
// structural (JSON Schema) layer is what rejects malformed manifests. Parse
// turns a structurally-valid document into the typed model and normalises
// defaults that the manifest left implicit.

type rawManifest struct {
	App       rawApp        `json:"app"`
	Entities  []rawEntity   `json:"entities"`
	Frontend  *rawFrontend  `json:"frontend"`
	Functions []rawFunction `json:"functions"`
	Tools     []rawTool     `json:"tools"`
}

type rawApp struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Emoji   string `json:"emoji"`
	Color   string `json:"color"`
	Version int    `json:"version"`
}

type rawFrontend struct {
	Dist  string `json:"dist"`
	Entry string `json:"entry"`
}

type rawEntity struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Operations []string   `json:"operations"`
	Fields     []rawField `json:"fields"`
}

type rawFunction struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Entry        string          `json:"entry"`
	Capabilities rawCapabilities `json:"capabilities"`
}

type rawCapabilities struct {
	Data    []rawDataScope `json:"data"`
	Network []string       `json:"network"`
	Model   bool           `json:"model"`
}

type rawDataScope struct {
	Entity     string   `json:"entity"`
	Operations []string `json:"operations"`
}

type rawField struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Type     string          `json:"type"`
	Required bool            `json:"required"`
	Unique   bool            `json:"unique"`
	Default  json.RawMessage `json:"default"`
	Min      *float64        `json:"min"`
	Max      *float64        `json:"max"`
	Values   []string        `json:"values"`
	Target   string          `json:"target"`
	OnDelete string          `json:"onDelete"`
}

type rawTool struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Params      []rawField    `json:"params"`
	Steps       []rawToolStep `json:"steps"`
}

type rawToolStep struct {
	ID     string                     `json:"id"`
	Op     string                     `json:"op"`
	Entity string                     `json:"entity"`
	RowID  json.RawMessage            `json:"rowId"`
	Set    map[string]json.RawMessage `json:"set"`
	Filter map[string]json.RawMessage `json:"filter"`
}

// Parse converts manifest bytes into the typed model. It assumes the bytes have
// already passed structural validation; it returns an error only on
// genuinely-unparseable JSON or a default that cannot be coerced to the field's
// type (the latter is also reported, with a path, by the semantic validator).
func Parse(data []byte) (*App, error) {
	var raw rawManifest
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("manifest is not valid JSON: %w", err)
	}

	app := &App{
		ID:      raw.App.ID,
		Name:    raw.App.Name,
		Emoji:   raw.App.Emoji,
		Color:   raw.App.Color,
		Version: raw.App.Version,
	}

	for _, re := range raw.Entities {
		ent := &Entity{
			ID:   re.ID,
			Name: re.Name,
		}
		if len(re.Operations) == 0 {
			ent.Operations = append([]Operation(nil), AllOperations...)
		} else {
			for _, op := range re.Operations {
				ent.Operations = append(ent.Operations, Operation(op))
			}
		}

		for _, rf := range re.Fields {
			f, err := parseField(rf)
			if err != nil {
				return nil, fmt.Errorf("entity %q field %q: %w", re.Name, rf.Name, err)
			}
			ent.Fields = append(ent.Fields, f)
		}
		app.Entities = append(app.Entities, ent)
	}

	if raw.Frontend != nil {
		entry := raw.Frontend.Entry
		if entry == "" {
			entry = "index.html"
		}
		app.Frontend = &Frontend{Dist: raw.Frontend.Dist, Entry: entry}
	}

	for _, rf := range raw.Functions {
		fn := &Function{
			ID:    rf.ID,
			Name:  rf.Name,
			Entry: rf.Entry,
			Capabilities: &Capabilities{
				Network: rf.Capabilities.Network,
				Model:   rf.Capabilities.Model,
			},
		}
		for _, rd := range rf.Capabilities.Data {
			ds := DataScope{Entity: rd.Entity}
			for _, op := range rd.Operations {
				ds.Operations = append(ds.Operations, Operation(op))
			}
			fn.Capabilities.Data = append(fn.Capabilities.Data, ds)
		}
		app.Functions = append(app.Functions, fn)
	}

	for _, rt := range raw.Tools {
		tool := &Tool{ID: rt.ID, Name: rt.Name, Description: rt.Description}
		for _, rp := range rt.Params {
			p, err := parseField(rp)
			if err != nil {
				return nil, fmt.Errorf("tool %q param %q: %w", rt.Name, rp.Name, err)
			}
			tool.Params = append(tool.Params, p)
		}
		for _, rs := range rt.Steps {
			step := &ToolStep{
				ID:     rs.ID,
				Op:     Operation(rs.Op),
				Entity: rs.Entity,
				RowID:  parseStepValue(rs.RowID),
			}
			for name, raw := range rs.Set {
				if step.Set == nil {
					step.Set = map[string]*StepValue{}
				}
				step.Set[name] = parseStepValue(raw)
			}
			for name, raw := range rs.Filter {
				if step.Filter == nil {
					step.Filter = map[string]*StepValue{}
				}
				step.Filter[name] = parseStepValue(raw)
			}
			tool.Steps = append(tool.Steps, step)
		}
		app.Tools = append(app.Tools, tool)
	}

	return app, nil
}

// parseField converts one manifest field (or tool param, which shares the
// same JSON shape) into the typed model.
func parseField(rf rawField) (*Field, error) {
	f := &Field{
		ID:       rf.ID,
		Name:     rf.Name,
		Type:     FieldType(rf.Type),
		Required: rf.Required,
		Unique:   rf.Unique,
		Min:      rf.Min,
		Max:      rf.Max,
		Values:   rf.Values,
		Target:   rf.Target,
	}
	if f.Type == TypeReference {
		f.OnDelete = rf.OnDelete
		if f.OnDelete == "" {
			f.OnDelete = OnDeleteSetNull
		}
	}
	if len(rf.Default) > 0 && string(rf.Default) != "null" {
		v, err := normaliseDefault(f.Type, rf.Default)
		if err != nil {
			return nil, err
		}
		f.HasDefault = true
		f.Default = v
	}
	return f, nil
}

// parseStepValue decodes a raw JSON template slot (a ToolStep's rowId, or one
// value in its set map) into a StepValue: a JSON string of the form
// "$params.<name>" or "$steps.<id>.<field>" is a reference (stored without
// its leading "$"); any other JSON value, including absent/null, is a
// literal (nil for absent/null).
func parseStepValue(raw json.RawMessage) *StepValue {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) == nil && strings.HasPrefix(s, "$") {
		return &StepValue{Ref: strings.TrimPrefix(s, "$")}
	}
	return &StepValue{Literal: raw}
}

// normaliseDefault decodes a raw default into the canonical Go type for the
// field, so the rest of the system never has to re-interpret JSON numbers.
func normaliseDefault(t FieldType, raw json.RawMessage) (any, error) {
	switch t {
	case TypeText, TypeDatetime, TypeEnum:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, fmt.Errorf("default must be a string")
		}
		return s, nil
	case TypeInteger:
		var n int64
		if err := json.Unmarshal(raw, &n); err != nil {
			return nil, fmt.Errorf("default must be an integer")
		}
		return n, nil
	case TypeReal:
		var n float64
		if err := json.Unmarshal(raw, &n); err != nil {
			return nil, fmt.Errorf("default must be a number")
		}
		return n, nil
	case TypeBoolean:
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, fmt.Errorf("default must be a boolean")
		}
		return b, nil
	default:
		return nil, fmt.Errorf("type %q does not support a default", t)
	}
}
