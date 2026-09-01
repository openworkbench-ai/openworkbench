package adminapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func doRequestWithBody(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

const todoManifest = `{
  "app": { "id": "todo", "name": "Todo", "version": 1 },
  "entities": [ { "id": "ent_task", "name": "task", "fields": [
    { "id": "fld_title", "name": "title", "type": "text", "required": true },
    { "id": "fld_done", "name": "done", "type": "boolean", "default": false }
  ]}]
}`

func TestSaveWritesManifestSkillsAndDataThenInstalls(t *testing.T) {
	h, catalogDir, reg := newTestServer(t)

	body := `{
	  "manifest": ` + todoManifest + `,
	  "skills": [{ "name": "log-task", "content": "---\nname: log-task\ndescription: how to log a task\n---\nBody." }],
	  "data": [{ "entity": "task", "rows": [{ "title": "first" }] }]
	}`
	rec := doRequestWithBody(t, h, "PUT", "/admin/apps/todo", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if _, err := os.Stat(filepath.Join(catalogDir, "todo", "manifest.json")); err != nil {
		t.Fatalf("manifest.json not written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(catalogDir, "todo", "skills", "log-task", "SKILL.md")); err != nil {
		t.Fatalf("skill not written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(catalogDir, "todo", "data", "task.json")); err != nil {
		t.Fatalf("seed data not written: %v", err)
	}

	rec = doRequest(t, h, "POST", "/admin/apps/todo/install")
	if rec.Code != http.StatusOK {
		t.Fatalf("install: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, ok := reg.App("todo"); !ok {
		t.Fatal("install must register the app as active")
	}
}

func TestSaveWithoutSkillsOrDataCreatesNoExtraDirs(t *testing.T) {
	h, catalogDir, _ := newTestServer(t)

	body := `{ "manifest": ` + todoManifest + ` }`
	rec := doRequestWithBody(t, h, "PUT", "/admin/apps/todo", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if _, err := os.Stat(filepath.Join(catalogDir, "todo", "skills")); !os.IsNotExist(err) {
		t.Fatalf("skills dir should not exist, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(catalogDir, "todo", "data")); !os.IsNotExist(err) {
		t.Fatalf("data dir should not exist, stat err = %v", err)
	}
}

func TestSaveInvalidManifestIs422AndWritesNothing(t *testing.T) {
	h, catalogDir, _ := newTestServer(t)

	body := `{ "manifest": { "app": { "id": "todo", "name": "Todo", "version": 1 }, "entities": [] } }`
	rec := doRequestWithBody(t, h, "PUT", "/admin/apps/todo", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422, body = %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(catalogDir, "todo")); !os.IsNotExist(err) {
		t.Fatalf("app dir should not exist, stat err = %v", err)
	}
}

func TestSaveIDMismatchIs422(t *testing.T) {
	h, _, _ := newTestServer(t)

	body := `{ "manifest": ` + todoManifest + ` }`
	rec := doRequestWithBody(t, h, "PUT", "/admin/apps/nottodo", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422, body = %s", rec.Code, rec.Body.String())
	}
	var respBody struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &respBody); err != nil {
		t.Fatal(err)
	}
	if respBody.Error.Code != "id_mismatch" {
		t.Fatalf("error code = %q, want id_mismatch", respBody.Error.Code)
	}
}

const bookManifestWithUI = `{
  "app": { "id": "books", "name": "Books", "version": 1 },
  "entities": [ { "id": "ent_book", "name": "book", "fields": [
    { "id": "fld_title", "name": "title", "type": "text", "required": true }
  ]}],
  "tools": [
    { "id": "tool_create_book", "name": "create_book",
      "params": [ { "id": "p_title", "name": "title", "type": "text", "required": true } ],
      "steps": [ { "op": "create", "entity": "ent_book", "set": { "title": "$params.title" } } ],
      "ui": { "component": "Book" }
    }
  ]
}`

func TestSaveWritesUIComponent(t *testing.T) {
	h, catalogDir, _ := newTestServer(t)

	body := `{
	  "manifest": ` + bookManifestWithUI + `,
	  "ui": [{ "name": "Book", "html": "<html>book</html>" }]
	}`
	rec := doRequestWithBody(t, h, "PUT", "/admin/apps/books", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	written, err := os.ReadFile(filepath.Join(catalogDir, "books", "ui", "Book.html"))
	if err != nil {
		t.Fatalf("ui/Book.html not written: %v", err)
	}
	if string(written) != "<html>book</html>" {
		t.Fatalf("ui/Book.html content = %q, want <html>book</html>", written)
	}
}

func TestSaveRejectsMissingUIComponent(t *testing.T) {
	h, catalogDir, _ := newTestServer(t)

	body := `{ "manifest": ` + bookManifestWithUI + ` }`
	rec := doRequestWithBody(t, h, "PUT", "/admin/apps/books", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422, body = %s", rec.Code, rec.Body.String())
	}
	var respBody struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &respBody); err != nil {
		t.Fatal(err)
	}
	if respBody.Error.Code != "missing_ui_component" {
		t.Fatalf("error code = %q, want missing_ui_component", respBody.Error.Code)
	}
	if _, err := os.Stat(filepath.Join(catalogDir, "books")); !os.IsNotExist(err) {
		t.Fatalf("app dir should not exist, stat err = %v", err)
	}
}

func TestSaveRejectsMalformedUIComponentName(t *testing.T) {
	h, _, _ := newTestServer(t)

	body := `{
	  "manifest": ` + bookManifestWithUI + `,
	  "ui": [{ "name": "../etc", "html": "nope" }]
	}`
	rec := doRequestWithBody(t, h, "PUT", "/admin/apps/books", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSaveRejectsPathTraversalSkillName(t *testing.T) {
	h, catalogDir, _ := newTestServer(t)

	body := `{
	  "manifest": ` + todoManifest + `,
	  "skills": [{ "name": "../../etc", "content": "nope" }]
	}`
	rec := doRequestWithBody(t, h, "PUT", "/admin/apps/todo", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(catalogDir, "todo")); !os.IsNotExist(err) {
		t.Fatalf("app dir should not exist, stat err = %v", err)
	}
}

func TestSaveRejectsMalformedID(t *testing.T) {
	h, _, _ := newTestServer(t)

	body := `{ "manifest": ` + todoManifest + ` }`
	rec := doRequestWithBody(t, h, "PUT", "/admin/apps/UPPER_case", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSaveReplacesExistingAppContent(t *testing.T) {
	h, catalogDir, _ := newTestServer(t)

	first := `{
	  "manifest": ` + todoManifest + `,
	  "skills": [{ "name": "old-skill", "content": "old" }]
	}`
	rec := doRequestWithBody(t, h, "PUT", "/admin/apps/todo", first)
	if rec.Code != http.StatusOK {
		t.Fatalf("first save: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	second := `{ "manifest": ` + todoManifest + ` }`
	rec = doRequestWithBody(t, h, "PUT", "/admin/apps/todo", second)
	if rec.Code != http.StatusOK {
		t.Fatalf("second save: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if _, err := os.Stat(filepath.Join(catalogDir, "todo", "skills", "old-skill")); !os.IsNotExist(err) {
		t.Fatalf("old skill from the first save should be gone after a full replace, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(catalogDir, "todo", "manifest.json")); err != nil {
		t.Fatalf("manifest.json should still exist: %v", err)
	}
}
