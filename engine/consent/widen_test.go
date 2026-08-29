package consent

import (
	"testing"

	"pocketknife/schema"
)

const widenBaseV1 = `{
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
    }}
  ]
}`

func TestWidenedDetectsNewDataScope(t *testing.T) {
	const v2 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 2 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text" }
    ]}
  ],
  "functions": [
    { "id": "fn_a", "name": "fn_a", "entry": "fn_a.wasm", "capabilities": {
      "data": [{ "entity": "ent_item", "operations": ["read", "delete"] }],
      "network": ["api.example.com"]
    }}
  ]
}`
	d := Widened(parseApp(t, widenBaseV1), parseApp(t, v2))
	if !d.RequiresReconsent() {
		t.Fatalf("expected reconsent required, got %+v", d)
	}
	if len(d.NewData) != 1 || d.NewData[0] != (DataGrant{EntityID: "ent_item", Operation: schema.OpDelete}) {
		t.Fatalf("expected exactly one new grant (delete), got %+v", d.NewData)
	}
	if len(d.NewNetwork) != 0 || d.NewModel {
		t.Fatalf("expected no other widening, got %+v", d)
	}
}

func TestWidenedDetectsNewDomain(t *testing.T) {
	const v2 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 2 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text" }
    ]}
  ],
  "functions": [
    { "id": "fn_a", "name": "fn_a", "entry": "fn_a.wasm", "capabilities": {
      "data": [{ "entity": "ent_item", "operations": ["read"] }],
      "network": ["api.example.com", "new.example.com"]
    }}
  ]
}`
	d := Widened(parseApp(t, widenBaseV1), parseApp(t, v2))
	if !d.RequiresReconsent() {
		t.Fatalf("expected reconsent required, got %+v", d)
	}
	if len(d.NewNetwork) != 1 || d.NewNetwork[0] != "new.example.com" {
		t.Fatalf("expected exactly one new domain, got %+v", d.NewNetwork)
	}
	if len(d.NewData) != 0 || d.NewModel {
		t.Fatalf("expected no other widening, got %+v", d)
	}
}

func TestWidenedDetectsModelFalseToTrue(t *testing.T) {
	const v2 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 2 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text" }
    ]}
  ],
  "functions": [
    { "id": "fn_a", "name": "fn_a", "entry": "fn_a.wasm", "capabilities": {
      "data": [{ "entity": "ent_item", "operations": ["read"] }],
      "network": ["api.example.com"],
      "model": true
    }}
  ]
}`
	d := Widened(parseApp(t, widenBaseV1), parseApp(t, v2))
	if !d.RequiresReconsent() {
		t.Fatalf("expected reconsent required, got %+v", d)
	}
	if !d.NewModel {
		t.Fatalf("expected NewModel true, got %+v", d)
	}
	if len(d.NewData) != 0 || len(d.NewNetwork) != 0 {
		t.Fatalf("expected no other widening, got %+v", d)
	}
}

func TestWidenedNoReconsentOnNarrowing(t *testing.T) {
	// v2 drops the network capability entirely and narrows nothing else: this
	// must never be flagged as a re-consent event, since the app can only do
	// less, not more.
	const v2 = `{
  "app": { "id": "tracker", "name": "Tracker", "version": 2 },
  "entities": [
    { "id": "ent_item", "name": "item", "fields": [
      { "id": "fld_title", "name": "title", "type": "text" }
    ]}
  ],
  "functions": [
    { "id": "fn_a", "name": "fn_a", "entry": "fn_a.wasm", "capabilities": {
      "data": [{ "entity": "ent_item", "operations": ["read"] }]
    }}
  ]
}`
	d := Widened(parseApp(t, widenBaseV1), parseApp(t, v2))
	if d.RequiresReconsent() {
		t.Fatalf("narrowing must not require reconsent, got %+v", d)
	}
}

func TestWidenedIdenticalManifestsNoReconsent(t *testing.T) {
	d := Widened(parseApp(t, widenBaseV1), parseApp(t, widenBaseV1))
	if d.RequiresReconsent() {
		t.Fatalf("identical manifests must not require reconsent, got %+v", d)
	}
}

func TestWidenedNilDeltaDoesNotRequireReconsent(t *testing.T) {
	var d *Delta
	if d.RequiresReconsent() {
		t.Fatalf("nil delta must not require reconsent")
	}
}
