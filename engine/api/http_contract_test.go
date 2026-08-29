package api_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// rawRequest sends method/url with body as literal, unmarshaled bytes —
// unlike do() (api_test.go), which always marshals a well-formed Go value,
// this can send deliberately malformed JSON.
func rawRequest(t *testing.T, method, url, rawBody string) resp {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(rawBody))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{status: res.StatusCode, raw: raw}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out.body)
	}
	return out
}

func rawPost(t *testing.T, url, rawBody string) resp  { return rawRequest(t, "POST", url, rawBody) }
func rawPatch(t *testing.T, url, rawBody string) resp { return rawRequest(t, "PATCH", url, rawBody) }

// These two tests pin deliberate Workbench HTTP-contract decisions made
// during the domain/ extraction — see the "Deliberate contract" comments
// on unknownFieldIssues and decodeBody in api/api.go for the rationale.
// Both corner cases were previously undocumented, untested behavior that
// happened to change during the refactor; they are now an intentional,
// regression-tested part of the API's contract, not an accident.

const contractManifest = `{
  "app": { "id": "contract_app", "name": "Contract App", "version": 1 },
  "entities": [
    { "id": "ent_widget", "name": "widget", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true }
    ]}
  ]
}`

// TestUnknownFieldShortCircuitsBeforeDomainValidation pins decision 1: a
// body with both an unknown field and a separate, valid-schema violation
// (a missing required field) reports ONLY the unknown-field issue — the two
// are never combined in one response — and, just as importantly, never
// reaches domain.Create at all, so no row is inserted.
func TestUnknownFieldShortCircuitsBeforeDomainValidation(t *testing.T) {
	srv := bootManifest(t, "contract_app", contractManifest)

	// "title" (required) is entirely absent AND "bogus" is unknown --
	// under the old, pre-refactor behavior both issues would appear
	// together; the current contract reports only the unknown field.
	resp := do(t, srv, "POST", "/apps/contract_app/widget", map[string]any{
		"bogus": "x",
	}).wantStatus(t, 400)

	errBody, _ := resp.body["error"].(map[string]any)
	if errBody == nil {
		t.Fatalf("expected an error envelope, got %v", resp.body)
	}
	details, _ := errBody["details"].([]any)
	if len(details) != 1 {
		t.Fatalf("details = %v, want exactly one issue (the unknown field)", details)
	}
	issue, _ := details[0].(map[string]any)
	if issue["field"] != "bogus" {
		t.Fatalf("issue = %v, want it to name the unknown field %q", issue, "bogus")
	}

	// No row was inserted: the widget list must still be empty.
	list := do(t, srv, "GET", "/apps/contract_app/widget", nil).wantStatus(t, 200)
	if total := list.body["total"].(float64); total != 0 {
		t.Fatalf("total = %v, want 0 — an unknown-field request must never insert a row", total)
	}
}

// TestMalformedBodyReportedBeforeAppResolution pins decision 2: a
// structurally-invalid JSON body against an app id that doesn't exist
// returns 400 invalid_body, not 404 app_not_found — HTTP-level body
// parsing gates domain resolution, deterministically, for every request.
func TestMalformedBodyReportedBeforeAppResolution(t *testing.T) {
	srv := bootManifest(t, "contract_app", contractManifest)

	req := rawPost(t, srv.URL+"/apps/does_not_exist/widget", "{not valid json")
	if req.status != 400 {
		t.Fatalf("status = %d, want 400", req.status)
	}
	errBody, _ := req.body["error"].(map[string]any)
	if errBody == nil || errBody["code"] != "invalid_body" {
		t.Fatalf("error = %v, want code invalid_body", errBody)
	}

	// The same malformed body against an update path behaves the same way.
	reqUpdate := rawPatch(t, srv.URL+"/apps/does_not_exist/widget/some-id", "{not valid json")
	if reqUpdate.status != 400 {
		t.Fatalf("PATCH status = %d, want 400", reqUpdate.status)
	}
	errBody2, _ := reqUpdate.body["error"].(map[string]any)
	if errBody2 == nil || errBody2["code"] != "invalid_body" {
		t.Fatalf("PATCH error = %v, want code invalid_body", errBody2)
	}
}
