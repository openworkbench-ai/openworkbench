package schema_test

import (
	"strings"
	"testing"

	"pocketknife/schema"
)

// mustParse parses body and fails the test on any error.
func mustParse(t *testing.T, body string) *schema.App {
	t.Helper()
	app, err := schema.Parse([]byte(body))
	if err != nil {
		t.Fatalf("Parse: unexpected error: %v", err)
	}
	return app
}

func TestParseValidManifestRoundTrip(t *testing.T) {
	app := mustParse(t, `{
      "app": { "id": "reading_tracker", "name": "Reading Tracker", "emoji": "📚", "color": "#8E86CF", "version": 3 },
      "entities": [
        { "id": "ent_book", "name": "book", "operations": ["create", "read"], "fields": [
          { "id": "fld_title",  "name": "title",  "type": "text",    "required": true, "max": 200 },
          { "id": "fld_rating", "name": "rating", "type": "integer", "min": 1, "max": 5 },
          { "id": "fld_score",  "name": "score",  "type": "real",    "default": 4.5 },
          { "id": "fld_done",   "name": "done",   "type": "boolean", "default": false }
        ]}
      ],
      "frontend": { "dist": "frontend/dist", "entry": "app.html" }
    }`)

	if app.ID != "reading_tracker" || app.Name != "Reading Tracker" || app.Emoji != "📚" || app.Color != "#8E86CF" || app.Version != 3 {
		t.Fatalf("app fields not preserved: %+v", app)
	}

	ent := app.Entity("book")
	if ent == nil {
		t.Fatal("entity \"book\" missing")
	}
	if ent.ID != "ent_book" {
		t.Fatalf("entity id = %q, want ent_book", ent.ID)
	}
	if len(ent.Operations) != 2 || ent.Operations[0] != schema.OpCreate || ent.Operations[1] != schema.OpRead {
		t.Fatalf("explicit operations not preserved: %v", ent.Operations)
	}

	title := ent.Field("title")
	if title == nil || title.Type != schema.TypeText || !title.Required || title.Max == nil || *title.Max != 200 {
		t.Fatalf("title field not parsed correctly: %+v", title)
	}

	rating := ent.Field("rating")
	if rating == nil || rating.Type != schema.TypeInteger || rating.Min == nil || *rating.Min != 1 || rating.Max == nil || *rating.Max != 5 {
		t.Fatalf("rating field not parsed correctly: %+v", rating)
	}

	score := ent.Field("score")
	if score == nil || !score.HasDefault {
		t.Fatalf("score field missing default: %+v", score)
	}
	if v, ok := score.Default.(float64); !ok || v != 4.5 {
		t.Fatalf("real default not normalised to float64: %#v", score.Default)
	}

	done := ent.Field("done")
	if done == nil || !done.HasDefault {
		t.Fatalf("done field missing default: %+v", done)
	}
	if v, ok := done.Default.(bool); !ok || v != false {
		t.Fatalf("boolean default not normalised to bool: %#v", done.Default)
	}

	if app.Frontend == nil || app.Frontend.Dist != "frontend/dist" || app.Frontend.Entry != "app.html" {
		t.Fatalf("frontend not parsed correctly: %+v", app.Frontend)
	}
}

func TestParseMalformedJSONIsWrappedError(t *testing.T) {
	_, err := schema.Parse([]byte(`{ not json `))
	if err == nil {
		t.Fatal("expected an error for malformed JSON")
	}
	if !strings.Contains(err.Error(), "manifest is not valid JSON") {
		t.Fatalf("error = %v, want wrapped \"manifest is not valid JSON\" message", err)
	}
}

func TestParseOperationsDefaultToAllFourWhenOmitted(t *testing.T) {
	app := mustParse(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_x", "name": "x", "fields": [
          { "id": "fld_y", "name": "y", "type": "text" }
        ]}
      ]
    }`)

	ent := app.Entity("x")
	if len(ent.Operations) != 4 {
		t.Fatalf("default operations = %v, want all four", ent.Operations)
	}
	for _, op := range schema.AllOperations {
		if !ent.Allows(op) {
			t.Fatalf("default operations missing %q", op)
		}
	}
}

func TestParseOnDeleteDefaultsOnlyForReferenceFields(t *testing.T) {
	app := mustParse(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_parent", "name": "parent", "fields": [
          { "id": "fld_label", "name": "label", "type": "text" }
        ]},
        { "id": "ent_child", "name": "child", "fields": [
          { "id": "fld_ref_default",  "name": "ref_default",  "type": "reference", "target": "ent_parent" },
          { "id": "fld_ref_explicit", "name": "ref_explicit", "type": "reference", "target": "ent_parent", "onDelete": "cascade" },
          { "id": "fld_label",        "name": "label",        "type": "text" }
        ]}
      ]
    }`)

	child := app.Entity("child")
	refDefault := child.Field("ref_default")
	if refDefault.OnDelete != schema.OnDeleteSetNull {
		t.Fatalf("reference OnDelete default = %q, want %q", refDefault.OnDelete, schema.OnDeleteSetNull)
	}
	refExplicit := child.Field("ref_explicit")
	if refExplicit.OnDelete != schema.OnDeleteCascade {
		t.Fatalf("reference OnDelete explicit = %q, want %q", refExplicit.OnDelete, schema.OnDeleteCascade)
	}
	label := child.Field("label")
	if label.OnDelete != "" {
		t.Fatalf("non-reference field got an OnDelete value: %q", label.OnDelete)
	}
}

func TestParseFrontendEntryDefaultsToIndexHTML(t *testing.T) {
	app := mustParse(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "ent_x", "name": "x", "fields": [{ "id": "fld_y", "name": "y", "type": "text" }] }],
      "frontend": { "dist": "dist" }
    }`)
	if app.Frontend == nil || app.Frontend.Entry != "index.html" {
		t.Fatalf("frontend entry default = %+v, want index.html", app.Frontend)
	}
}

func TestParseFrontendAbsentWhenOmitted(t *testing.T) {
	app := mustParse(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "ent_x", "name": "x", "fields": [{ "id": "fld_y", "name": "y", "type": "text" }] }]
    }`)
	if app.Frontend != nil {
		t.Fatalf("frontend = %+v, want nil when omitted", app.Frontend)
	}
}

func TestParseDefaultNormalisationPerType(t *testing.T) {
	app := mustParse(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_x", "name": "x", "fields": [
          { "id": "fld_text",     "name": "text_f",     "type": "text",     "default": "hi" },
          { "id": "fld_int",      "name": "int_f",      "type": "integer",  "default": 7 },
          { "id": "fld_real",     "name": "real_f",     "type": "real",     "default": 1.5 },
          { "id": "fld_bool",     "name": "bool_f",     "type": "boolean",  "default": true },
          { "id": "fld_datetime", "name": "datetime_f", "type": "datetime", "default": "2026-01-01T00:00:00.000Z" },
          { "id": "fld_enum",     "name": "enum_f",     "type": "enum",     "values": ["a","b"], "default": "b" }
        ]}
      ]
    }`)
	ent := app.Entity("x")

	if v, ok := ent.Field("text_f").Default.(string); !ok || v != "hi" {
		t.Fatalf("text default = %#v", ent.Field("text_f").Default)
	}
	if v, ok := ent.Field("int_f").Default.(int64); !ok || v != 7 {
		t.Fatalf("integer default not normalised to int64: %#v", ent.Field("int_f").Default)
	}
	if v, ok := ent.Field("real_f").Default.(float64); !ok || v != 1.5 {
		t.Fatalf("real default not normalised to float64: %#v", ent.Field("real_f").Default)
	}
	if v, ok := ent.Field("bool_f").Default.(bool); !ok || v != true {
		t.Fatalf("boolean default = %#v", ent.Field("bool_f").Default)
	}
	// datetime defaults are preserved as the raw manifest string; canonicalization
	// happens later, when the default is actually written to a row.
	if v, ok := ent.Field("datetime_f").Default.(string); !ok || v != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("datetime default = %#v, want the raw string preserved", ent.Field("datetime_f").Default)
	}
	if v, ok := ent.Field("enum_f").Default.(string); !ok || v != "b" {
		t.Fatalf("enum default = %#v", ent.Field("enum_f").Default)
	}
}

func TestParseReferenceDefaultIsRejected(t *testing.T) {
	_, err := schema.Parse([]byte(`{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_parent", "name": "parent", "fields": [{ "id": "fld_l", "name": "l", "type": "text" }] },
        { "id": "ent_child", "name": "child", "fields": [
          { "id": "fld_ref", "name": "ref", "type": "reference", "target": "ent_parent", "default": "x" }
        ]}
      ]
    }`))
	if err == nil {
		t.Fatal("expected an error for a reference field default")
	}
	if !strings.Contains(err.Error(), "does not support a default") {
		t.Fatalf("error = %v, want \"does not support a default\"", err)
	}
}

func TestParseUnknownTypeWithDefaultIsRejected(t *testing.T) {
	_, err := schema.Parse([]byte(`{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_x", "name": "x", "fields": [
          { "id": "fld_y", "name": "y", "type": "bogus", "default": "x" }
        ]}
      ]
    }`))
	if err == nil {
		t.Fatal("expected an error for an unrecognized field type with a default")
	}
	if !strings.Contains(err.Error(), "does not support a default") {
		t.Fatalf("error = %v, want \"does not support a default\"", err)
	}
}

func TestParseUnknownTypeWithoutDefaultParsesWithNoError(t *testing.T) {
	// schema.Parse itself does not close the type set; that's the structural
	// validator's job (via manifest.schema.json's enum). A field with an
	// unrecognized type and no default parses successfully at this layer.
	app := mustParse(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_x", "name": "x", "fields": [
          { "id": "fld_y", "name": "y", "type": "bogus" }
        ]}
      ]
    }`)
	f := app.Entity("x").Field("y")
	if f == nil || f.Type != schema.FieldType("bogus") {
		t.Fatalf("field = %+v, want type \"bogus\" preserved verbatim", f)
	}
	if f.HasDefault {
		t.Fatalf("field unexpectedly has a default: %+v", f)
	}
}

func TestParseNullOrAbsentDefaultMeansNoDefault(t *testing.T) {
	app := mustParse(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_x", "name": "x", "fields": [
          { "id": "fld_absent", "name": "absent", "type": "text" },
          { "id": "fld_null",   "name": "null_default", "type": "text", "default": null }
        ]}
      ]
    }`)
	ent := app.Entity("x")
	if f := ent.Field("absent"); f.HasDefault {
		t.Fatalf("absent default field: HasDefault = true, want false")
	}
	if f := ent.Field("null_default"); f.HasDefault {
		t.Fatalf("literal null default field: HasDefault = true, want false")
	}
}

func TestEntityAndAppLookupHelpers(t *testing.T) {
	app := mustParse(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_book", "name": "book", "operations": ["read"], "fields": [
          { "id": "fld_title", "name": "title", "type": "text" }
        ]}
      ],
      "functions": [
        { "id": "fn_sum", "name": "summarize", "entry": "functions/sum.wasm",
          "capabilities": { "data": [{ "entity": "ent_book", "operations": ["read"] }], "network": ["api.example.com"], "model": true } }
      ]
    }`)

	if app.Entity("book") == nil || app.Entity("nope") != nil {
		t.Fatal("App.Entity lookup by name incorrect")
	}
	if app.EntityByID("ent_book") == nil || app.EntityByID("nope") != nil {
		t.Fatal("App.EntityByID lookup incorrect")
	}
	ent := app.Entity("book")
	if ent.Field("title") == nil || ent.Field("nope") != nil {
		t.Fatal("Entity.Field lookup by name incorrect")
	}
	if ent.FieldByID("fld_title") == nil || ent.FieldByID("nope") != nil {
		t.Fatal("Entity.FieldByID lookup incorrect")
	}
	if !ent.Allows(schema.OpRead) || ent.Allows(schema.OpDelete) {
		t.Fatal("Entity.Allows incorrect for explicit operations list")
	}

	if app.Function("summarize") == nil || app.Function("nope") != nil {
		t.Fatal("App.Function lookup by name incorrect")
	}
	if app.FunctionByID("fn_sum") == nil || app.FunctionByID("nope") != nil {
		t.Fatal("App.FunctionByID lookup incorrect")
	}

	fn := app.Function("summarize")
	if !fn.Capabilities.Allows("ent_book", schema.OpRead) {
		t.Fatal("Capabilities.Allows should permit the declared entity/operation")
	}
	if fn.Capabilities.Allows("ent_book", schema.OpDelete) {
		t.Fatal("Capabilities.Allows should deny an operation not in scope")
	}
	if fn.Capabilities.Allows("ent_other", schema.OpRead) {
		t.Fatal("Capabilities.Allows should deny an entity with no scope at all")
	}
	if !fn.Capabilities.AllowsDomain("api.example.com") {
		t.Fatal("Capabilities.AllowsDomain should permit the allow-listed host")
	}
	if fn.Capabilities.AllowsDomain("evil.example.com") {
		t.Fatal("Capabilities.AllowsDomain should deny a non-allow-listed host")
	}

	var nilCaps *schema.Capabilities
	if nilCaps.Allows("ent_book", schema.OpRead) || nilCaps.AllowsDomain("api.example.com") {
		t.Fatal("nil Capabilities must deny everything")
	}
}
