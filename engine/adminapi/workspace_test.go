package adminapi_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pocketknife/store"
)

func applyBody(manifest string, confirm bool) string {
	raw, _ := json.Marshal(map[string]any{"manifest": json.RawMessage(manifest), "confirm": confirm})
	return string(raw)
}

func TestWorkspaceApplyPreservesRowsAcrossSchemaAndMetadataEdits(t *testing.T) {
	h, catalog, reg := newTestServer(t)
	res := doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(todoManifest, false))
	if res.Code != 200 {
		t.Fatalf("initial apply %d %s", res.Code, res.Body.String())
	}
	ra, _ := reg.App("todo")
	row, err := ra.Store.Insert(ra.Schema.Entities[0], map[string]any{"id": "row_keep", "title": "Keep me", "done": false, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	updated := strings.Replace(todoManifest, `"name": "Todo"`, `"name": "My projects"`, 1)
	updated = strings.Replace(updated, `"id": "fld_done"`, `"id": "fld_notes", "name": "notes", "type": "text" }, { "id": "fld_done"`, 1)
	res = doRequestWithBody(t, h, "POST", "/admin/apps/todo/changes", updated)
	if res.Code != 200 || !strings.Contains(res.Body.String(), "add_field") {
		t.Fatalf("preview %d %s", res.Code, res.Body.String())
	}
	res = doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(updated, false))
	if res.Code != 200 {
		t.Fatalf("update %d %s", res.Code, res.Body.String())
	}
	ra, _ = reg.App("todo")
	saved, err := ra.Store.GetByID(ra.Schema.Entities[0], row["id"].(string))
	if err != nil || saved["title"] != "Keep me" {
		t.Fatalf("lost data: %#v %v", saved, err)
	}
	if ra.Schema.Name != "My projects" {
		t.Fatalf("metadata not updated: %s", ra.Schema.Name)
	}
	raw, _ := os.ReadFile(filepath.Join(catalog, "todo", "manifest.json"))
	if !strings.Contains(string(raw), "fld_notes") {
		t.Fatal("source did not follow activation")
	}
}

func TestWorkspaceApplyRejectsUnconfirmedDestructionAndMissingBackfills(t *testing.T) {
	h, catalog, reg := newTestServer(t)
	res := doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(todoManifest, false))
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	dropped := strings.Replace(todoManifest, `,`+"\n"+`    { "id": "fld_done", "name": "done", "type": "boolean", "default": false }`, "", 1)
	res = doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(dropped, false))
	if res.Code != 409 {
		t.Fatalf("unconfirmed removal accepted: %d %s", res.Code, res.Body.String())
	}
	required := strings.Replace(todoManifest, `"id": "fld_done"`, `"id": "fld_new", "name": "new_required", "type": "text", "required": true }, { "id": "fld_done"`, 1)
	res = doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(required, true))
	if res.Code != 422 || !strings.Contains(res.Body.String(), "backfill") {
		t.Fatalf("missing backfill accepted: %d %s", res.Code, res.Body.String())
	}
	ra, _ := reg.App("todo")
	if len(ra.Schema.Entities[0].Fields) != 2 {
		t.Fatal("failed apply changed registry")
	}
	raw, _ := os.ReadFile(filepath.Join(catalog, "todo", "manifest.json"))
	if strings.Contains(string(raw), "fld_new") {
		t.Fatal("failed apply changed source")
	}
	res = doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(dropped, true))
	if res.Code != 200 {
		t.Fatalf("confirmed drop failed: %d %s", res.Code, res.Body.String())
	}
}

func TestWorkspaceApplyPreservesDisabledStateAndSourceHelpers(t *testing.T) {
	h, catalog, reg := newTestServer(t)
	doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(todoManifest, false))
	doRequest(t, h, "POST", "/admin/apps/todo/deactivate")
	updated := strings.Replace(todoManifest, `"name": "Todo"`, `"name": "Disabled Todo"`, 1)
	body, _ := json.Marshal(map[string]any{"manifest": json.RawMessage(updated), "sourceFiles": []map[string]string{{"path": "ui/components/format.ts", "content": "export const format = () => 'ok'"}}})
	res := doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", string(body))
	if res.Code != 200 {
		t.Fatalf("update %d %s", res.Code, res.Body.String())
	}
	if status, _ := reg.Status("todo"); status != "inactive" {
		t.Fatal("apply enabled a disabled app")
	}
	if _, err := os.Stat(filepath.Join(catalog, "todo", "ui", "components", "format.ts")); err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceApplyStoresBuiltUIAlongsideEditableSource(t *testing.T) {
	h, catalog, _ := newTestServer(t)
	body, _ := json.Marshal(map[string]any{
		"manifest":    json.RawMessage(todoManifest),
		"ui":          []map[string]string{{"name": "TaskCard", "html": "<html>built component</html>", "tsx": "export default function TaskCard() { return null }"}},
		"sourceFiles": []map[string]string{{"path": "ui/components/TaskCard.tsx", "content": "export default function TaskCard() { return null }"}, {"path": "ui/components/format.ts", "content": "export const format = () => 'ok'"}},
	})
	res := doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", string(body))
	if res.Code != 200 {
		t.Fatalf("apply %d %s", res.Code, res.Body.String())
	}
	for _, path := range []string{"ui/TaskCard.html", "ui/components/TaskCard.tsx", "ui/components/format.ts"} {
		if _, err := os.Stat(filepath.Join(catalog, "todo", path)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWorkspaceApplyRejectsInvalidCandidateWithoutChangingRows(t *testing.T) {
	h, catalog, reg := newTestServer(t)
	doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(todoManifest, false))
	ra, _ := reg.App("todo")
	_, err := ra.Store.Insert(ra.Schema.Entities[0], map[string]any{"id": "row_keep", "title": "keep", "done": false, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	// A bad default is rejected by validation before staging or touching data.
	bad := strings.Replace(todoManifest, `"default": false`, `"default": "not_boolean"`, 1)
	res := doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(bad, true))
	if res.Code != 422 {
		t.Fatalf("bad manifest accepted: %d %s", res.Code, res.Body.String())
	}
	ra, _ = reg.App("todo")
	rows, total, err := ra.Store.List(ra.Schema.Entities[0], store.ListQuery{Limit: 10})
	if err != nil || total != 1 || rows[0]["title"] != "keep" {
		t.Fatalf("prior rows changed: %#v %v", rows, err)
	}
	raw, _ := os.ReadFile(filepath.Join(catalog, "todo", "manifest.json"))
	if strings.Contains(string(raw), "not_boolean") {
		t.Fatal("rejected source became live")
	}
}

func TestWorkspaceApplyConfirmsCapabilityExpansionAndRejectsSourceTraversal(t *testing.T) {
	h, _, _ := newTestServer(t)
	doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(todoManifest, false))
	var manifest map[string]any
	json.Unmarshal([]byte(todoManifest), &manifest)
	manifest["functions"] = []any{map[string]any{"id": "fn_search", "name": "search", "runtime": "python", "entry": "functions/search.py", "capabilities": map[string]any{"network": []string{"example.com"}}}}
	body, _ := json.Marshal(map[string]any{"manifest": manifest, "functionFiles": []map[string]string{{"path": "functions/search.py", "content": "def main(): return {}"}}})
	res := doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", string(body))
	if res.Code != 409 {
		t.Fatalf("unconfirmed network expansion: %d %s", res.Code, res.Body.String())
	}
	body, _ = json.Marshal(map[string]any{"manifest": json.RawMessage(todoManifest), "sourceFiles": []map[string]string{{"path": "ui/components/../../secret", "content": "bad"}}})
	res = doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", string(body))
	if res.Code != 400 {
		t.Fatalf("source escape accepted: %d %s", res.Code, res.Body.String())
	}
}

func TestWorkspaceMigrationFailureKeepsPriorSourceRegistrationAndRows(t *testing.T) {
	h, catalog, reg := newTestServer(t)
	doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(todoManifest, false))
	ra, _ := reg.App("todo")
	for _, id := range []string{"row_one", "row_two"} {
		_, err := ra.Store.Insert(ra.Schema.Entities[0], map[string]any{"id": id, "title": "duplicate", "done": false, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"})
		if err != nil {
			t.Fatal(err)
		}
	}
	unique := strings.Replace(todoManifest, `"required": true`, `"required": true, "unique": true`, 1)
	res := doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", applyBody(unique, true))
	if res.Code != 422 || !strings.Contains(res.Body.String(), "UNIQUE") {
		t.Fatalf("expected migration failure, got %d %s", res.Code, res.Body.String())
	}
	ra, ok := reg.App("todo")
	if !ok || ra.Schema.Entities[0].Fields[0].Unique {
		t.Fatal("failed migration changed registration")
	}
	_, total, err := ra.Store.List(ra.Schema.Entities[0], store.ListQuery{Limit: 10})
	if err != nil || total != 2 {
		t.Fatalf("migration lost rows: %d %v", total, err)
	}
	raw, _ := os.ReadFile(filepath.Join(catalog, "todo", "manifest.json"))
	if strings.Contains(string(raw), `"unique"`) {
		t.Fatal("failed migration changed source")
	}
}

func TestWorkspaceFailedFirstSeedCanBeCorrectedAndRetried(t *testing.T) {
	h, _, reg := newTestServer(t)
	body, _ := json.Marshal(map[string]any{"manifest": json.RawMessage(todoManifest), "data": []map[string]any{{"entity": "task", "rows": []map[string]any{{"title": "valid"}, {"unknown": "invalid"}}}}})
	res := doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", string(body))
	if res.Code != 422 {
		t.Fatalf("expected seed rejection, got %d %s", res.Code, res.Body.String())
	}
	if _, ok := reg.App("todo"); ok {
		t.Fatal("failed seed activated an app")
	}
	body, _ = json.Marshal(map[string]any{"manifest": json.RawMessage(todoManifest), "data": []map[string]any{{"entity": "task", "rows": []map[string]any{{"title": "one"}, {"title": "two"}}}}})
	res = doRequestWithBody(t, h, "POST", "/admin/apps/todo/apply", string(body))
	if res.Code != 200 {
		t.Fatalf("retry failed %d %s", res.Code, res.Body.String())
	}
	ra, _ := reg.App("todo")
	rows, total, err := ra.Store.List(ra.Schema.Entities[0], store.ListQuery{Limit: 10})
	if err != nil || total != 2 {
		t.Fatalf("seed retry did not start clean: %#v total=%d err=%v", rows, total, err)
	}
}
