package adminapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"pocketknife/adminapi"
	"pocketknife/registry"
)

func writeManifest(t *testing.T, catalogDir, appID, body string) {
	t.Helper()
	dir := filepath.Join(catalogDir, appID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const notesV1 = `{
  "app": { "id": "notes", "name": "Notes", "version": 1 },
  "entities": [ { "id": "ent_note", "name": "note", "fields": [
    { "id": "fld_title", "name": "title", "type": "text", "required": true }
  ]}]
}`

func newTestServer(t *testing.T) (http.Handler, string, *registry.Registry) {
	t.Helper()
	catalogDir, dataDir := t.TempDir(), t.TempDir()
	reg := registry.New()
	t.Cleanup(func() { reg.Close() })
	return adminapi.NewServer(reg, catalogDir, dataDir), catalogDir, reg
}

func doRequest(t *testing.T, h http.Handler, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestInstallActivateDeactivateRoundTrip(t *testing.T) {
	h, catalogDir, reg := newTestServer(t)
	writeManifest(t, catalogDir, "notes", notesV1)

	rec := doRequest(t, h, "POST", "/admin/apps/notes/install")
	if rec.Code != http.StatusOK {
		t.Fatalf("install: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, ok := reg.App("notes"); !ok {
		t.Fatal("install must register the app as active")
	}

	rec = doRequest(t, h, "GET", "/admin/apps")
	if rec.Code != http.StatusOK {
		t.Fatalf("list: status = %d", rec.Code)
	}
	var listBody struct {
		Apps []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listBody); err != nil {
		t.Fatal(err)
	}
	if len(listBody.Apps) != 1 || listBody.Apps[0].ID != "notes" || listBody.Apps[0].Status != "active" {
		t.Fatalf("unexpected list body: %+v", listBody.Apps)
	}

	rec = doRequest(t, h, "POST", "/admin/apps/notes/deactivate")
	if rec.Code != http.StatusOK {
		t.Fatalf("deactivate: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, ok := reg.App("notes"); ok {
		t.Fatal("deactivate must remove the app from the served set")
	}

	// Deactivating again is a well-formed but redundant request -> 409, not 500.
	rec = doRequest(t, h, "POST", "/admin/apps/notes/deactivate")
	if rec.Code != http.StatusConflict {
		t.Fatalf("double deactivate: status = %d, want 409", rec.Code)
	}

	rec = doRequest(t, h, "POST", "/admin/apps/notes/activate")
	if rec.Code != http.StatusOK {
		t.Fatalf("activate: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, ok := reg.App("notes"); !ok {
		t.Fatal("activate must restore the app to the served set")
	}
}

func TestActivateUnknownAppIs404(t *testing.T) {
	h, _, _ := newTestServer(t)
	rec := doRequest(t, h, "POST", "/admin/apps/nope/activate")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404, body = %s", rec.Code, rec.Body.String())
	}
}

func TestInstallInvalidManifestIs422(t *testing.T) {
	h, catalogDir, reg := newTestServer(t)
	writeManifest(t, catalogDir, "bad", `{
      "app": { "id": "bad", "name": "Bad", "version": 1 },
      "entities": [ { "id": "ent_x", "name": "x", "fields": [
        { "id": "fld_id", "name": "id", "type": "text" }
      ]}]
    }`)

	rec := doRequest(t, h, "POST", "/admin/apps/bad/install")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422, body = %s", rec.Code, rec.Body.String())
	}
	if _, ok := reg.App("bad"); ok {
		t.Fatal("an invalid manifest must never be registered")
	}
}

// TestInstallRejectsMalformedID proves {id} is validated against the
// manifest schema's stableId pattern before it's ever joined onto
// catalogDir -- the guard the package doc promises. "UPPER_case" is a
// single path segment (so it reaches the handler, unlike a literal ".."
// segment ServeMux would clean/redirect before ever routing here) but
// fails the same pattern a path-traversal payload would also fail.
func TestInstallRejectsMalformedID(t *testing.T) {
	h, _, reg := newTestServer(t)
	rec := doRequest(t, h, "POST", "/admin/apps/UPPER_case/install")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "invalid_id" {
		t.Fatalf("error code = %q, want invalid_id", body.Error.Code)
	}
	if _, ok := reg.App("UPPER_case"); ok {
		t.Fatal("a rejected id must never reach the registry")
	}
}
