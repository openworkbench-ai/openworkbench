package schema_test

import (
	"strings"
	"testing"

	"pocketknife/schema"
)

func mustParseApp(t *testing.T, body string) *schema.App {
	t.Helper()
	app, err := schema.Parse([]byte(body))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return app
}

const fpBase = `{
  "app": { "id": "a", "name": "A", "version": 1 },
  "entities": [
    { "id": "ent_book", "name": "book", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true, "max": 200 },
      { "id": "fld_rating", "name": "rating", "type": "integer", "min": 1, "max": 5 }
    ]}
  ]
}`

func TestFingerprintIsDeterministicAcrossFormattingAndOrder(t *testing.T) {
	a := mustParseApp(t, fpBase)
	// Same semantics, different key order, whitespace, entity/field order.
	b := mustParseApp(t, `{
      "entities": [
        { "fields": [
            { "type": "integer", "id": "fld_rating", "name": "rating", "max": 5, "min": 1 },
            { "max": 200, "id": "fld_title", "required": true, "name": "title", "type": "text" }
          ], "id": "ent_book", "name": "book" }
      ],
      "app": { "version": 1, "name": "A", "id": "a" }
    }`)

	if schema.Fingerprint(a) != schema.Fingerprint(b) {
		t.Fatal("fingerprints differ for semantically identical manifests with different formatting/order")
	}
}

func TestFingerprintIgnoresEntityAndFieldRename(t *testing.T) {
	a := mustParseApp(t, fpBase)
	renamed := mustParseApp(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [
        { "id": "ent_book", "name": "renamed_entity", "fields": [
          { "id": "fld_title", "name": "renamed_title", "type": "text", "required": true, "max": 200 },
          { "id": "fld_rating", "name": "renamed_rating", "type": "integer", "min": 1, "max": 5 }
        ]}
      ]
    }`)

	if schema.Fingerprint(a) != schema.Fingerprint(renamed) {
		t.Fatal("a pure rename (same stable ids) must not change the fingerprint — storage is id-keyed and moves no data")
	}
}

func TestFingerprintIgnoresDefaultValueChange(t *testing.T) {
	a := mustParseApp(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "ent_x", "name": "x", "fields": [
        { "id": "fld_flag", "name": "flag", "type": "boolean", "default": false }
      ]}]
    }`)
	b := mustParseApp(t, `{
      "app": { "id": "a", "name": "A", "version": 1 },
      "entities": [{ "id": "ent_x", "name": "x", "fields": [
        { "id": "fld_flag", "name": "flag", "type": "boolean", "default": true }
      ]}]
    }`)

	if schema.Fingerprint(a) != schema.Fingerprint(b) {
		t.Fatal("a default-value-only change must not change the fingerprint — materialize never emits a SQL DEFAULT clause")
	}
}

func TestFingerprintIgnoresOperationsAndDisplayMetadata(t *testing.T) {
	a := mustParseApp(t, `{
      "app": { "id": "a", "name": "A", "emoji": "📚", "color": "#111111", "version": 1 },
      "entities": [{ "id": "ent_x", "name": "x", "operations": ["create", "read"], "fields": [
        { "id": "fld_y", "name": "y", "type": "text" }
      ]}]
    }`)
	b := mustParseApp(t, `{
      "app": { "id": "a", "name": "Something Else", "emoji": "🚀", "color": "#ffffff", "version": 1 },
      "entities": [{ "id": "ent_x", "name": "x", "operations": ["create", "read", "update", "delete"], "fields": [
        { "id": "fld_y", "name": "y", "type": "text" }
      ]}]
    }`)

	if schema.Fingerprint(a) != schema.Fingerprint(b) {
		t.Fatal("app display metadata and entity operations must not affect the fingerprint")
	}
}

func TestFingerprintChangesForEachSchemaRelevantConstraint(t *testing.T) {
	base := func() string {
		return `{
          "app": { "id": "a", "name": "A", "version": 1 },
          "entities": [
            { "id": "ent_parent", "name": "parent", "fields": [{ "id": "fld_l", "name": "l", "type": "text" }] },
            { "id": "ent_other",  "name": "other",  "fields": [{ "id": "fld_l", "name": "l", "type": "text" }] },
            { "id": "ent_x", "name": "x", "fields": [
              { "id": "fld_title",  "name": "title",  "type": "text",      "required": false, "max": 200 },
              { "id": "fld_kind",   "name": "kind",   "type": "enum",      "values": ["a", "b"] },
              { "id": "fld_parent", "name": "parent", "type": "reference", "target": "ent_parent", "onDelete": "set_null" }
            ]}
          ]
        }`
	}
	baseline := schema.Fingerprint(mustParseApp(t, base()))

	variants := map[string]string{
		"required": `"required": true, "max": 200`,
		"max":      `"required": false, "max": 50`,
		"unique":   `"required": false, "max": 200, "unique": true`,
	}
	for name, titleFields := range variants {
		manifest := replaceOnce(t, base(), `"required": false, "max": 200`, titleFields)
		fp := schema.Fingerprint(mustParseApp(t, manifest))
		if fp == baseline {
			t.Errorf("%s: expected fingerprint to change, got the same value", name)
		}
	}

	enumChanged := schema.Fingerprint(mustParseApp(t, replaceOnce(t, base(), `"values": ["a", "b"]`, `"values": ["a"]`)))
	if enumChanged == baseline {
		t.Error("enum value removal: expected fingerprint to change")
	}

	retargeted := schema.Fingerprint(mustParseApp(t, replaceOnce(t, base(), `"target": "ent_parent"`, `"target": "ent_other"`)))
	if retargeted == baseline {
		t.Error("reference retarget: expected fingerprint to change")
	}

	onDeleteChanged := schema.Fingerprint(mustParseApp(t, replaceOnce(t, base(), `"onDelete": "set_null"`, `"onDelete": "cascade"`)))
	if onDeleteChanged == baseline {
		t.Error("onDelete change: expected fingerprint to change")
	}
}

// replaceOnce swaps exactly one occurrence of old for new, failing the test
// if old isn't found — a stand-in for strings.Replace(s, old, new, 1) that
// also catches a typo'd fixture instead of silently no-op'ing.
func replaceOnce(t *testing.T, s, old, new string) string {
	t.Helper()
	if !strings.Contains(s, old) {
		t.Fatalf("fixture does not contain %q", old)
	}
	return strings.Replace(s, old, new, 1)
}
