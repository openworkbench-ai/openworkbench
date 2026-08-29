package validate_test

import (
	"strings"
	"testing"

	"pocketknife/schema"
	"pocketknife/validate"
)

func mustValid(t *testing.T, body string) *schema.App {
	t.Helper()
	app, errs := validate.Manifest([]byte(body))
	if len(errs) > 0 {
		t.Fatalf("expected valid manifest, got errors: %v", errs)
	}
	if app == nil {
		t.Fatal("valid manifest returned nil app")
	}
	return app
}

// hasCode reports whether any error carries the given code.
func hasCode(errs validate.Errors, code string) bool {
	for _, e := range errs {
		if e.Code == code {
			return true
		}
	}
	return false
}

func mustInvalid(t *testing.T, body string) validate.Errors {
	t.Helper()
	app, errs := validate.Manifest([]byte(body))
	if len(errs) == 0 {
		t.Fatal("expected validation errors, got none")
	}
	if app != nil {
		t.Fatal("invalid manifest must not return a model")
	}
	return errs
}

func TestValidManifestParsesDefaults(t *testing.T) {
	app := mustValid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_t", "name": "thing", "fields": [
          { "id": "f1", "name": "title", "type": "text", "required": true, "max": 10 },
          { "id": "f2", "name": "flag", "type": "boolean", "default": true },
          { "id": "f3", "name": "kind", "type": "enum", "values": ["a","b"], "default": "b" }
        ]}
      ]
    }`)

	ent := app.Entity("thing")
	if ent == nil {
		t.Fatal("entity missing")
	}
	// operations defaulted to all four
	if len(ent.Operations) != 4 {
		t.Fatalf("default operations = %v", ent.Operations)
	}
	flag := ent.Field("flag")
	if !flag.HasDefault || flag.Default != true {
		t.Fatalf("boolean default = %v has=%v", flag.Default, flag.HasDefault)
	}
}

func TestRejectsUnknownTopLevelKey(t *testing.T) {
	errs := mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [{ "id": "f", "name": "y", "type": "text" }]}],
      "surprise": true
    }`)
	if !hasCode(errs, "structural") {
		t.Fatalf("expected structural error, got %v", errs)
	}
}

func TestRejectsUnknownFieldKey(t *testing.T) {
	mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "f", "name": "y", "type": "text", "bogus": 1 }
      ]}]
    }`)
}

func TestRejectsConstraintKeyNotAllowedForType(t *testing.T) {
	// "values" is only valid for enum, not for text.
	mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "f", "name": "y", "type": "text", "values": ["a"] }
      ]}]
    }`)
}

func TestRejectsUnknownType(t *testing.T) {
	mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "f", "name": "y", "type": "money" }
      ]}]
    }`)
}

func TestRejectsReservedFieldName(t *testing.T) {
	errs := mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "f", "name": "created_at", "type": "datetime" }
      ]}]
    }`)
	if !hasCode(errs, "reserved_name") {
		t.Fatalf("expected reserved_name error, got %v", errs)
	}
}

func TestRejectsBadName(t *testing.T) {
	// uppercase is not allowed by the machine-name pattern.
	mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "Bad", "fields": [
        { "id": "f", "name": "y", "type": "text" }
      ]}]
    }`)
}

func TestRejectsUnsafeStableID(t *testing.T) {
	// Stable ids become physical SQLite identifiers (D1), so they must match the
	// SQL-safe pattern. A hyphen and an uppercase letter are both rejected.
	mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "ent-bad", "name": "x", "fields": [
        { "id": "f", "name": "y", "type": "text" }
      ]}]
    }`)
	mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "Fld", "name": "y", "type": "text" }
      ]}]
    }`)
}

func TestRejectsReservedFieldID(t *testing.T) {
	// A field id becomes a physical column name, so it must not collide with a
	// platform-managed column.
	errs := mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "created_at", "name": "y", "type": "datetime" }
      ]}]
    }`)
	if !hasCode(errs, "reserved_id") {
		t.Fatalf("expected reserved_id error, got %v", errs)
	}
}

func TestRejectsDuplicateIDs(t *testing.T) {
	errs := mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "dup", "name": "a", "type": "text" },
        { "id": "dup", "name": "b", "type": "text" }
      ]}]
    }`)
	if !hasCode(errs, "duplicate_id") {
		t.Fatalf("expected duplicate_id, got %v", errs)
	}
}

func TestRejectsDuplicateNames(t *testing.T) {
	errs := mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "f1", "name": "same", "type": "text" },
        { "id": "f2", "name": "same", "type": "text" }
      ]}]
    }`)
	if !hasCode(errs, "duplicate_name") {
		t.Fatalf("expected duplicate_name, got %v", errs)
	}
}

func TestRejectsUnresolvedReference(t *testing.T) {
	errs := mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "f", "name": "y", "type": "reference", "target": "ent_missing" }
      ]}]
    }`)
	if !hasCode(errs, "unresolved_reference") {
		t.Fatalf("expected unresolved_reference, got %v", errs)
	}
}

func TestRejectsEnumDefaultNotInValues(t *testing.T) {
	errs := mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "f", "name": "y", "type": "enum", "values": ["a","b"], "default": "z" }
      ]}]
    }`)
	if !hasCode(errs, "bad_default") {
		t.Fatalf("expected bad_default, got %v", errs)
	}
}

func TestRejectsDefaultViolatingConstraint(t *testing.T) {
	errs := mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "f", "name": "y", "type": "integer", "min": 1, "max": 5, "default": 9 }
      ]}]
    }`)
	if !hasCode(errs, "bad_default") {
		t.Fatalf("expected bad_default, got %v", errs)
	}
}

func TestRejectsDeclaringPlatformColumnViaReserved(t *testing.T) {
	errs := mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "f", "name": "updated_at", "type": "datetime" }
      ]}]
    }`)
	if !hasCode(errs, "reserved_name") {
		t.Fatalf("expected reserved_name, got %v", errs)
	}
}

func TestErrorsAreStructuredWithPath(t *testing.T) {
	errs := mustInvalid(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "e", "name": "x", "fields": [
        { "id": "f", "name": "y", "type": "integer", "min": 1, "max": 5, "default": 9 }
      ]}]
    }`)
	for _, e := range errs {
		if e.Path == "" || e.Code == "" || e.Message == "" {
			t.Fatalf("error missing structured fields: %+v", e)
		}
		if !strings.HasPrefix(e.Path, "/") {
			t.Fatalf("path should be a pointer-like location: %q", e.Path)
		}
	}
}

func TestExampleAppsAreValid(t *testing.T) {
	for _, body := range []string{
		`{"app":{"id":"reading_tracker","name":"R","version":1},"entities":[{"id":"ent_book","name":"book","operations":["create","read","update","delete"],"fields":[{"id":"fld_title","name":"title","type":"text","required":true,"max":200},{"id":"fld_done","name":"done","type":"boolean","default":false}]}]}`,
		`{"app":{"id":"gratitude_log","name":"G","version":1},"entities":[{"id":"ent_entry","name":"entry","operations":["create","read"],"fields":[{"id":"fld_text","name":"text","type":"text","required":true}]}]}`,
	} {
		if _, errs := validate.Manifest([]byte(body)); len(errs) > 0 {
			t.Fatalf("example-like manifest should validate: %v", errs)
		}
	}
}
