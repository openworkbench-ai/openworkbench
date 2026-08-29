package consent

import (
	"testing"

	"pocketknife/schema"
	"pocketknife/validate"
)

// parseApp parses a manifest through the real validator so consent tests run
// against the same typed model the runtime uses.
func parseApp(t *testing.T, body string) *schema.App {
	t.Helper()
	app, errs := validate.Manifest([]byte(body))
	if len(errs) > 0 {
		t.Fatalf("manifest invalid: %v", errs)
	}
	return app
}

const noFunctions = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 1 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text" }
    ]}
  ]
}`

func TestUnionEmptyWhenNoFunctions(t *testing.T) {
	c := Union(parseApp(t, noFunctions))
	if !c.IsEmpty() {
		t.Fatalf("expected empty union, got %+v", c)
	}
}

const twoFunctionsOverlapping = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 1 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text" }
    ]}
  ],
  "functions": [
    { "id": "fn_a", "name": "fn_a", "entry": "fn_a.wasm", "capabilities": {
      "data": [{ "entity": "ent_item", "operations": ["read"] }],
      "network": ["api.example.com"]
    }},
    { "id": "fn_b", "name": "fn_b", "entry": "fn_b.wasm", "capabilities": {
      "data": [{ "entity": "ent_item", "operations": ["read", "update"] }],
      "network": ["api.example.com", "other.example.com"],
      "model": true
    }}
  ]
}`

func TestUnionDeduplicatesAcrossFunctions(t *testing.T) {
	c := Union(parseApp(t, twoFunctionsOverlapping))

	if len(c.Data) != 2 {
		t.Fatalf("expected 2 distinct data grants, got %d: %+v", len(c.Data), c.Data)
	}
	want := map[DataGrant]bool{
		{EntityID: "ent_item", Operation: schema.OpRead}:   true,
		{EntityID: "ent_item", Operation: schema.OpUpdate}: true,
	}
	for _, g := range c.Data {
		if !want[g] {
			t.Fatalf("unexpected data grant in union: %+v", g)
		}
	}

	if len(c.Network) != 2 || c.Network[0] != "api.example.com" || c.Network[1] != "other.example.com" {
		t.Fatalf("expected deduplicated, sorted domains, got %v", c.Network)
	}

	if !c.Model {
		t.Fatalf("expected model true: fn_b declares it")
	}
}

func TestUnionIsOrderIndependent(t *testing.T) {
	const reordered = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 1 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text" }
    ]}
  ],
  "functions": [
    { "id": "fn_b", "name": "fn_b", "entry": "fn_b.wasm", "capabilities": {
      "data": [{ "entity": "ent_item", "operations": ["update", "read"] }],
      "network": ["other.example.com", "api.example.com"],
      "model": true
    }},
    { "id": "fn_a", "name": "fn_a", "entry": "fn_a.wasm", "capabilities": {
      "data": [{ "entity": "ent_item", "operations": ["read"] }],
      "network": ["api.example.com"]
    }}
  ]
}`
	a := Union(parseApp(t, twoFunctionsOverlapping))
	b := Union(parseApp(t, reordered))

	if len(a.Data) != len(b.Data) || len(a.Network) != len(b.Network) || a.Model != b.Model {
		t.Fatalf("union should not depend on declaration order: %+v vs %+v", a, b)
	}
	for i := range a.Data {
		if a.Data[i] != b.Data[i] {
			t.Fatalf("data grant order mismatch at %d: %+v vs %+v", i, a.Data[i], b.Data[i])
		}
	}
	for i := range a.Network {
		if a.Network[i] != b.Network[i] {
			t.Fatalf("network order mismatch at %d: %q vs %q", i, a.Network[i], b.Network[i])
		}
	}
}

func TestUnionFunctionWithNilCapabilitiesIsSkipped(t *testing.T) {
	// validateCapabilities and the schema require a capabilities object, but
	// Union must not panic if a function ever has none — defend the
	// invariant explicitly rather than relying on the manifest schema alone.
	app := parseApp(t, noFunctions)
	app.Functions = append(app.Functions, &schema.Function{ID: "fn_bare", Name: "fn_bare"})

	c := Union(app)
	if !c.IsEmpty() {
		t.Fatalf("expected empty union for a function with nil capabilities, got %+v", c)
	}
}
