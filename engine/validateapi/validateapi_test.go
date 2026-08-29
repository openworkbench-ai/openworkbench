package validateapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pocketknife/validateapi"
)

const validManifest = `{
  "app": { "id": "tasks", "name": "Tasks", "version": 1 },
  "entities": [
    { "id": "ent_task", "name": "task", "fields": [
      { "id": "fld_title", "name": "title", "type": "text", "required": true }
    ]}
  ]
}`

// invalidManifest is structurally fine but semantically broken: the reference
// points at an entity id that does not exist in the manifest.
const invalidManifest = `{
  "app": { "id": "tasks", "name": "Tasks", "version": 1 },
  "entities": [
    { "id": "ent_task", "name": "task", "fields": [
      { "id": "fld_proj", "name": "project", "type": "reference", "target": "ent_missing" }
    ]}
  ]
}`

type validateResp struct {
	Valid  bool `json:"valid"`
	Errors []struct {
		Path    string `json:"path"`
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

func post(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/validate", strings.NewReader(body))
	rec := httptest.NewRecorder()
	validateapi.NewServer().ServeHTTP(rec, req)
	return rec
}

func TestValidManifestReturnsValid(t *testing.T) {
	rec := post(t, validManifest)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	var resp validateResp
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if !resp.Valid {
		t.Fatalf("valid = false, want true; errors: %+v", resp.Errors)
	}
	if len(resp.Errors) != 0 {
		t.Fatalf("errors should be empty on a valid manifest, got %+v", resp.Errors)
	}
}

func TestInvalidManifestReturnsErrors(t *testing.T) {
	rec := post(t, invalidManifest)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body: %s", rec.Code, rec.Body.String())
	}
	var resp validateResp
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if resp.Valid {
		t.Fatal("valid = true, want false for a broken manifest")
	}
	if len(resp.Errors) == 0 {
		t.Fatal("expected at least one structured error")
	}
}

func TestEmptyBodyIsBadRequest(t *testing.T) {
	rec := post(t, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", rec.Code, rec.Body.String())
	}
}

func TestMalformedJSONReturnsStructuredError(t *testing.T) {
	rec := post(t, "{ not json")
	// Malformed JSON fails the validation gate as invalid_json, surfaced as a
	// 422 with a structured error list rather than a transport-level 400.
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body: %s", rec.Code, rec.Body.String())
	}
	var resp validateResp
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if resp.Valid || len(resp.Errors) == 0 {
		t.Fatalf("expected valid=false with errors, got %+v", resp)
	}
}
