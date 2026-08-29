package api_test

import (
	"testing"
)

// sqlInjectionManifest is a minimal app used to prove that request-controlled
// filter values and field names can never alter the generated SQL: values are
// always bound parameters, and field names are only ever accepted after being
// resolved against the schema (resolveColumn), never spliced into SQL text.
const sqlInjectionManifest = `{
  "app": { "id": "inj_app", "name": "Injection App", "version": 1 },
  "entities": [
    { "id": "ent_widget", "name": "widget", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true }
    ]}
  ]
}`

// TestFilterValueCannotAlterGeneratedSQL proves a SQL-metacharacter-laden
// filter *value* is treated as an opaque bound parameter: it can never match
// unrelated rows, never errors as if it were SQL, and never affects the
// table's contents.
func TestFilterValueCannotAlterGeneratedSQL(t *testing.T) {
	srv := bootManifest(t, "inj_app", sqlInjectionManifest)

	do(t, srv, "POST", "/apps/inj_app/widget", map[string]any{"title": "safe row"}).wantStatus(t, 201)

	payloads := []string{
		"'; DROP TABLE widget; --",
		"' OR '1'='1",
		"x' UNION SELECT id, id, id, id FROM widget --",
	}
	for _, p := range payloads {
		r := do(t, srv, "GET", listURL("inj_app/widget", "title:like:"+p), nil).wantStatus(t, 200)
		if got := r.body["total"].(float64); got != 0 {
			t.Fatalf("payload %q matched %v rows, want 0 (value must be a bound parameter, not SQL)", p, got)
		}
	}

	// The table must still exist and the original row must be untouched —
	// proof that none of the payloads above executed as SQL.
	after := do(t, srv, "GET", "/apps/inj_app/widget", nil).wantStatus(t, 200)
	if got := after.body["total"].(float64); got != 1 {
		t.Fatalf("row count after injection attempts = %v, want 1 (table must survive intact)", got)
	}
}

// TestFilterFieldNameCannotAlterGeneratedSQL proves an attempted SQL
// injection via the filter *field name* is rejected as an unknown field
// (resolveColumn only ever accepts a name already declared on the schema),
// never treated as a raw identifier spliced into SQL text.
func TestFilterFieldNameCannotAlterGeneratedSQL(t *testing.T) {
	srv := bootManifest(t, "inj_app", sqlInjectionManifest)

	do(t, srv, "POST", "/apps/inj_app/widget", map[string]any{"title": "safe row"}).wantStatus(t, 201)

	// filter=<field>:<op>:<value> splits on ":" with a limit of 3, so an
	// injection attempt confined to the field segment (no colon inside it)
	// arrives at resolveColumn whole and must fail to resolve.
	r := do(t, srv, "GET", listURL("inj_app/widget", "title; DROP TABLE widget; --:eq:x"), nil).wantStatus(t, 400)
	if r.body["error"] == nil {
		t.Fatalf("expected a structured error envelope, got %v", r.body)
	}

	// The table must still exist and the original row must be untouched.
	after := do(t, srv, "GET", "/apps/inj_app/widget", nil).wantStatus(t, 200)
	if got := after.body["total"].(float64); got != 1 {
		t.Fatalf("row count after injection attempt = %v, want 1 (table must survive intact)", got)
	}
}
