package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pocketknife/api"
	"pocketknife/registry"
)

// bookManifest is a synthetic fixture exercising CRUD, required/max-length
// text, a bounded integer, and a boolean default — the generic API surface,
// decoupled from any real catalog app so this suite never drifts out of sync
// with what happens to be in catalog/.
const bookManifest = `{
  "app": { "id": "book_app", "name": "Book App", "version": 1 },
  "entities": [
    { "id": "ent_book", "name": "book", "operations": ["create", "read", "update", "delete"], "fields": [
      { "id": "fld_title",  "name": "title",  "type": "text",    "required": true, "max": 200 },
      { "id": "fld_author", "name": "author", "type": "text" },
      { "id": "fld_rating", "name": "rating", "type": "integer", "min": 1, "max": 5 },
      { "id": "fld_done",   "name": "done",   "type": "boolean", "default": false }
    ]}
  ]
}`

// entryManifest exercises an entity whose declared operations restrict it to
// create/read only.
const entryManifest = `{
  "app": { "id": "entry_app", "name": "Entry App", "version": 1 },
  "entities": [
    { "id": "ent_entry", "name": "entry", "operations": ["create", "read"], "fields": [
      { "id": "fld_text", "name": "text", "type": "text", "required": true }
    ]}
  ]
}`

// tasksManifest exercises a unique constraint, an enum default, and a
// reference field's onDelete: set_null behavior.
const tasksManifest = `{
  "app": { "id": "tasks_app", "name": "Tasks App", "version": 1 },
  "entities": [
    { "id": "ent_project", "name": "project", "operations": ["create", "read", "update", "delete"], "fields": [
      { "id": "fld_project_name", "name": "name", "type": "text", "required": true, "unique": true, "max": 120 }
    ]},
    { "id": "ent_task", "name": "task", "operations": ["create", "read", "update", "delete"], "fields": [
      { "id": "fld_task_title",    "name": "title",    "type": "text",      "required": true, "max": 200 },
      { "id": "fld_task_project",  "name": "project",  "type": "reference", "target": "ent_project", "onDelete": "set_null" },
      { "id": "fld_task_priority", "name": "priority", "type": "enum",      "values": ["low", "medium", "high"], "default": "medium" }
    ]}
  ]
}`

// bootManifests writes each manifest under its app id and boots a registry +
// HTTP server over all of them together.
func bootManifests(t *testing.T, manifests map[string]string) *httptest.Server {
	t.Helper()
	root := t.TempDir()
	for appID, m := range manifests {
		dir := filepath.Join(root, appID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(m), 0o644); err != nil {
			t.Fatal(err)
		}
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
	srv := httptest.NewServer(api.NewServer(reg))
	t.Cleanup(func() {
		srv.Close()
		reg.Close()
	})
	return srv
}

// bootManifest boots a single app's manifest. appID must match the manifest's
// own app.id.
func bootManifest(t *testing.T, appID, manifest string) *httptest.Server {
	t.Helper()
	return bootManifests(t, map[string]string{appID: manifest})
}

// --- HTTP helpers ---

type resp struct {
	status int
	body   map[string]any
	raw    []byte
}

func do(t *testing.T, srv *httptest.Server, method, path string, body any) resp {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, srv.URL+path, rdr)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	res, err := srv.Client().Do(req)
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

func (r resp) wantStatus(t *testing.T, want int) resp {
	t.Helper()
	if r.status != want {
		t.Fatalf("status = %d, want %d; body=%s", r.status, want, r.raw)
	}
	return r
}

// --- book_app: CRUD, validation, list ---

func TestBookAppCRUD(t *testing.T) {
	srv := bootManifest(t, "book_app", bookManifest)

	// Create.
	created := do(t, srv, "POST", "/apps/book_app/book", map[string]any{
		"title": "The Go Programming Language", "author": "Donovan", "rating": 5,
	}).wantStatus(t, 201)

	id, _ := created.body["id"].(string)
	if id == "" {
		t.Fatal("created row missing id")
	}
	if created.body["created_at"] == nil || created.body["updated_at"] == nil {
		t.Fatal("platform timestamps not set")
	}
	if created.body["done"] != false {
		t.Fatalf("default done = %v, want false", created.body["done"])
	}
	if created.body["author"] != "Donovan" {
		t.Fatalf("author = %v", created.body["author"])
	}

	// Read.
	got := do(t, srv, "GET", "/apps/book_app/book/"+id, nil).wantStatus(t, 200)
	if got.body["title"] != "The Go Programming Language" {
		t.Fatalf("read title = %v", got.body["title"])
	}

	// Cross a millisecond boundary so the updated_at bump is observable at the
	// canonical timestamp resolution (otherwise a fast create→update can share a
	// millisecond and the bump, though it happened, is not visible).
	time.Sleep(2 * time.Millisecond)

	// Update (partial): bump rating, mark done.
	updated := do(t, srv, "PATCH", "/apps/book_app/book/"+id, map[string]any{
		"rating": 4, "done": true,
	}).wantStatus(t, 200)
	if updated.body["rating"].(float64) != 4 || updated.body["done"] != true {
		t.Fatalf("update not applied: %v", updated.body)
	}
	if updated.body["title"] != "The Go Programming Language" {
		t.Fatalf("untouched field changed: %v", updated.body["title"])
	}
	if updated.body["updated_at"] == created.body["updated_at"] {
		t.Errorf("updated_at not bumped")
	}

	// Delete + confirm gone.
	do(t, srv, "DELETE", "/apps/book_app/book/"+id, nil).wantStatus(t, 204)
	do(t, srv, "GET", "/apps/book_app/book/"+id, nil).wantStatus(t, 404)
}

func TestBookAppValidation(t *testing.T) {
	srv := bootManifest(t, "book_app", bookManifest)

	// rating out of range.
	do(t, srv, "POST", "/apps/book_app/book", map[string]any{"title": "x", "rating": 0}).wantStatus(t, 400)
	do(t, srv, "POST", "/apps/book_app/book", map[string]any{"title": "x", "rating": 6}).wantStatus(t, 400)

	// title missing.
	do(t, srv, "POST", "/apps/book_app/book", map[string]any{"rating": 3}).wantStatus(t, 400)

	// title too long.
	do(t, srv, "POST", "/apps/book_app/book", map[string]any{"title": strings.Repeat("a", 201)}).wantStatus(t, 400)

	// title exactly 200 is fine.
	do(t, srv, "POST", "/apps/book_app/book", map[string]any{"title": strings.Repeat("a", 200)}).wantStatus(t, 201)
}

func TestBookAppListFilterSortPaginate(t *testing.T) {
	srv := bootManifest(t, "book_app", bookManifest)

	mk := func(title string, done bool) {
		do(t, srv, "POST", "/apps/book_app/book", map[string]any{"title": title, "done": done}).wantStatus(t, 201)
	}
	mk("a", true)
	mk("b", false)
	mk("c", true)
	mk("d", false)

	// filter=done:eq:true
	f := do(t, srv, "GET", "/apps/book_app/book?filter=done:eq:true", nil).wantStatus(t, 200)
	if f.body["total"].(float64) != 2 {
		t.Fatalf("filtered total = %v, want 2", f.body["total"])
	}
	if n := len(f.body["data"].([]any)); n != 2 {
		t.Fatalf("filtered rows = %d, want 2", n)
	}

	// sort=-title returns titles in descending order ("d" first). Sorting on an
	// explicit field keeps this assertion deterministic regardless of insert
	// timing (created_at can tie within a millisecond).
	s := do(t, srv, "GET", "/apps/book_app/book?sort=-title", nil).wantStatus(t, 200)
	data := s.body["data"].([]any)
	if first := data[0].(map[string]any); first["title"] != "d" {
		t.Fatalf("sort -title first = %v, want d", first["title"])
	}
	if last := data[len(data)-1].(map[string]any); last["title"] != "a" {
		t.Fatalf("sort -title last = %v, want a", last["title"])
	}

	// pagination: total ignores limit/offset.
	p := do(t, srv, "GET", "/apps/book_app/book?limit=1&offset=2", nil).wantStatus(t, 200)
	if p.body["total"].(float64) != 4 {
		t.Fatalf("paginated total = %v, want 4", p.body["total"])
	}
	if len(p.body["data"].([]any)) != 1 {
		t.Fatalf("limit=1 returned %d rows", len(p.body["data"].([]any)))
	}
	if p.body["limit"].(float64) != 1 || p.body["offset"].(float64) != 2 {
		t.Fatalf("limit/offset echo wrong: %v", p.body)
	}
}

// --- entry_app: restricted operations ---

func TestEntryAppOperationsRestricted(t *testing.T) {
	srv := bootManifest(t, "entry_app", entryManifest)

	created := do(t, srv, "POST", "/apps/entry_app/entry", map[string]any{"text": "grateful for tests"}).wantStatus(t, 201)
	if created.body["created_at"] == nil {
		t.Fatal("created_at not set automatically")
	}
	id := created.body["id"].(string)

	do(t, srv, "GET", "/apps/entry_app/entry/"+id, nil).wantStatus(t, 200)
	do(t, srv, "GET", "/apps/entry_app/entry", nil).wantStatus(t, 200)

	// update and delete are disabled.
	do(t, srv, "PATCH", "/apps/entry_app/entry/"+id, map[string]any{"text": "x"}).wantStatus(t, 405)
	do(t, srv, "DELETE", "/apps/entry_app/entry/"+id, nil).wantStatus(t, 405)
}

// --- tasks_app: references, enum, unique ---

func TestTasksAppReferencesEnumUnique(t *testing.T) {
	srv := bootManifest(t, "tasks_app", tasksManifest)

	proj := do(t, srv, "POST", "/apps/tasks_app/project", map[string]any{"name": "Home"}).wantStatus(t, 201)
	projID := proj.body["id"].(string)

	// duplicate project name -> 409
	do(t, srv, "POST", "/apps/tasks_app/project", map[string]any{"name": "Home"}).wantStatus(t, 409)

	// valid task with default priority "medium"
	task := do(t, srv, "POST", "/apps/tasks_app/task", map[string]any{"title": "Mow lawn", "project": projID}).wantStatus(t, 201)
	if task.body["priority"] != "medium" {
		t.Fatalf("default priority = %v, want medium", task.body["priority"])
	}

	// non-existent project reference -> 400
	do(t, srv, "POST", "/apps/tasks_app/task", map[string]any{"title": "x", "project": "does_not_exist"}).wantStatus(t, 400)

	// priority outside enum -> 400
	do(t, srv, "POST", "/apps/tasks_app/task", map[string]any{"title": "x", "priority": "urgent"}).wantStatus(t, 400)
}

func TestTasksAppOnDeleteSetNull(t *testing.T) {
	srv := bootManifest(t, "tasks_app", tasksManifest)

	proj := do(t, srv, "POST", "/apps/tasks_app/project", map[string]any{"name": "Garden"}).wantStatus(t, 201)
	projID := proj.body["id"].(string)
	task := do(t, srv, "POST", "/apps/tasks_app/task", map[string]any{"title": "Weed", "project": projID}).wantStatus(t, 201)
	taskID := task.body["id"].(string)

	// delete the referenced project
	do(t, srv, "DELETE", "/apps/tasks_app/project/"+projID, nil).wantStatus(t, 204)

	// the task survives, its project reference is now null
	got := do(t, srv, "GET", "/apps/tasks_app/task/"+taskID, nil).wantStatus(t, 200)
	if got.body["project"] != nil {
		t.Fatalf("project not set to null after delete: %v", got.body["project"])
	}
}

func TestCrossAppIsolation(t *testing.T) {
	srv := bootManifests(t, map[string]string{"book_app": bookManifest, "tasks_app": tasksManifest})

	// tasks_app's "task" entity must not exist under book_app.
	do(t, srv, "GET", "/apps/book_app/task", nil).wantStatus(t, 404)
	do(t, srv, "POST", "/apps/book_app/task", map[string]any{"title": "x"}).wantStatus(t, 404)

	// unknown app and unknown entity both 404.
	do(t, srv, "GET", "/apps/nope/book", nil).wantStatus(t, 404)
	do(t, srv, "GET", "/apps/book_app/nope", nil).wantStatus(t, 404)
}
