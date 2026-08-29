package domain_test

// These tests call domain.Create/Get/List/Update/Delete directly — no
// net/http, no httptest server anywhere in this file. That absence is the
// point: it's the executable proof that a transport-neutral caller (a
// future MCP tool, or any other internal Workbench caller) can invoke these
// operations exactly as api/ does, without going through HTTP and without
// reimplementing field validation.

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"pocketknife/domain"
	"pocketknife/registry"
)

func bootApp(t *testing.T, appID, manifest string) *registry.Registry {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, appID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatalf("boot: %v", err)
	}
	for _, r := range results {
		if !r.OK {
			t.Fatalf("app %s failed to load: errors=%v err=%v", r.ManifestPath, r.Errors, r.Err)
		}
	}
	t.Cleanup(func() { reg.Close() })
	return reg
}

func raw(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func body(m map[string]any) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(m))
	for k, v := range m {
		out[k] = raw(v)
	}
	return out
}

const booksManifest = `{
  "app": { "id": "books", "name": "Books", "version": 1 },
  "entities": [
    { "id": "ent_project", "name": "project", "fields": [
      { "id": "fld_name", "name": "name", "type": "text", "required": true, "unique": true }
    ]},
    { "id": "ent_book", "name": "book", "operations": ["create", "read"], "fields": [
      { "id": "fld_title",   "name": "title",   "type": "text", "required": true, "max": 200 },
      { "id": "fld_rating",  "name": "rating",  "type": "integer", "min": 1, "max": 5 },
      { "id": "fld_done",    "name": "done",    "type": "boolean", "default": false },
      { "id": "fld_project", "name": "project", "type": "reference", "target": "ent_project" }
    ]}
  ]
}`

func TestCreateGetUpdateDeleteRoundTrip(t *testing.T) {
	reg := bootApp(t, "books", booksManifest)

	row, operr := domain.Create(reg, "books", "project", body(map[string]any{"name": "Home"}))
	if operr != nil {
		t.Fatalf("create project: %+v", operr)
	}
	id, _ := row["id"].(string)
	if id == "" || row["created_at"] == nil || row["updated_at"] == nil {
		t.Fatalf("created row missing platform columns: %v", row)
	}

	got, operr := domain.Get(reg, "books", "project", id)
	if operr != nil {
		t.Fatalf("get: %+v", operr)
	}
	if got["name"] != "Home" {
		t.Fatalf("get name = %v, want Home", got["name"])
	}

	updated, operr := domain.Update(reg, "books", "project", id, body(map[string]any{"name": "Garden"}))
	if operr != nil {
		t.Fatalf("update: %+v", operr)
	}
	if updated["name"] != "Garden" {
		t.Fatalf("update name = %v, want Garden", updated["name"])
	}

	deleted, operr := domain.Delete(reg, "books", "project", id)
	if operr != nil {
		t.Fatalf("delete: %+v", operr)
	}
	if !deleted {
		t.Fatal("delete reported false for an existing row")
	}

	if _, operr := domain.Get(reg, "books", "project", id); operr == nil || operr.Kind != domain.ErrRowNotFound {
		t.Fatalf("get after delete: operr = %+v, want ErrRowNotFound", operr)
	}
}

func TestCreateValidationCollectsAllIssues(t *testing.T) {
	reg := bootApp(t, "books", booksManifest)

	_, operr := domain.Create(reg, "books", "book", body(map[string]any{"rating": 9}))
	if operr == nil || operr.Kind != domain.ErrValidation {
		t.Fatalf("operr = %+v, want ErrValidation", operr)
	}
	// Both problems (missing title, out-of-range rating) must be reported
	// together, not just the first one encountered.
	if len(operr.Issues) != 2 {
		t.Fatalf("issues = %+v, want 2 (missing title + out-of-range rating)", operr.Issues)
	}
}

func TestCreateDanglingReferenceIsValidationNotConflict(t *testing.T) {
	reg := bootApp(t, "books", booksManifest)

	_, operr := domain.Create(reg, "books", "book", body(map[string]any{"title": "x", "project": "does-not-exist"}))
	if operr == nil || operr.Kind != domain.ErrValidation {
		t.Fatalf("operr = %+v, want ErrValidation for a dangling reference", operr)
	}
}

func TestCreateUniqueConflict(t *testing.T) {
	reg := bootApp(t, "books", booksManifest)

	if _, operr := domain.Create(reg, "books", "project", body(map[string]any{"name": "Home"})); operr != nil {
		t.Fatalf("first create: %+v", operr)
	}
	_, operr := domain.Create(reg, "books", "project", body(map[string]any{"name": "Home"}))
	if operr == nil || operr.Kind != domain.ErrUnique {
		t.Fatalf("operr = %+v, want ErrUnique", operr)
	}
}

func TestAppEntityAndOperationErrors(t *testing.T) {
	reg := bootApp(t, "books", booksManifest)

	if _, operr := domain.Get(reg, "nope", "project", "x"); operr == nil || operr.Kind != domain.ErrAppNotFound {
		t.Fatalf("unknown app: operr = %+v, want ErrAppNotFound", operr)
	}
	if _, operr := domain.Get(reg, "books", "nope", "x"); operr == nil || operr.Kind != domain.ErrEntityNotFound {
		t.Fatalf("unknown entity: operr = %+v, want ErrEntityNotFound", operr)
	}
	// "book" only allows create/read (see booksManifest) — update is disabled.
	if _, operr := domain.Update(reg, "books", "book", "x", body(map[string]any{"title": "y"})); operr == nil || operr.Kind != domain.ErrOperationDisabled {
		t.Fatalf("disabled operation: operr = %+v, want ErrOperationDisabled", operr)
	}
}

func TestUpdateAndDeleteRowNotFound(t *testing.T) {
	reg := bootApp(t, "books", booksManifest)

	if _, operr := domain.Update(reg, "books", "project", "missing-id", body(map[string]any{"name": "x"})); operr == nil || operr.Kind != domain.ErrRowNotFound {
		t.Fatalf("update missing row: operr = %+v, want ErrRowNotFound", operr)
	}
	if _, operr := domain.Delete(reg, "books", "project", "missing-id"); operr == nil || operr.Kind != domain.ErrRowNotFound {
		t.Fatalf("delete missing row: operr = %+v, want ErrRowNotFound", operr)
	}
}

func TestListFilterSortAndPagination(t *testing.T) {
	reg := bootApp(t, "books", booksManifest)

	for _, title := range []string{"a", "b", "c", "d"} {
		if _, operr := domain.Create(reg, "books", "book", body(map[string]any{"title": title})); operr != nil {
			t.Fatalf("seed %q: %+v", title, operr)
		}
	}

	res, operr := domain.List(reg, "books", "book", url.Values{"sort": {"-title"}, "limit": {"2"}})
	if operr != nil {
		t.Fatalf("list: %+v", operr)
	}
	if res.Total != 4 {
		t.Fatalf("total = %d, want 4 (total ignores limit)", res.Total)
	}
	if res.Limit != 2 || len(res.Rows) != 2 {
		t.Fatalf("limit not applied: limit=%d rows=%d", res.Limit, len(res.Rows))
	}
	if res.Rows[0]["title"] != "d" {
		t.Fatalf("sort -title first = %v, want d", res.Rows[0]["title"])
	}

	if _, operr := domain.List(reg, "books", "book", url.Values{"filter": {"nope:eq:x"}}); operr == nil || operr.Kind != domain.ErrInvalidQuery {
		t.Fatalf("unknown filter field: operr = %+v, want ErrInvalidQuery", operr)
	}
}
