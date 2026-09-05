package mcpserver_test

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"pocketknife/mcpserver"
)

func toolNames(t *testing.T, listed *mcp.ListToolsResult) map[string]bool {
	t.Helper()
	names := map[string]bool{}
	for _, tl := range listed.Tools {
		names[tl.Name] = true
	}
	return names
}

func TestGenericToolsFillGapsWithoutDuplicatingDeclaredNames(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)
	ts := httptest.NewServer(mcpserver.NewServer(reg))
	defer ts.Close()

	session := connect(t, ts.URL+"/mcp/tasks")
	ctx := context.Background()

	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	names := toolNames(t, listed)

	// Neither entity declares an "operations" list, so both default to
	// full CRUD -- every op should get a generic tool, except create_task,
	// whose name the manifest's own declared tool already claims.
	for _, want := range []string{"list_project", "get_project", "create_project", "update_project", "delete_project", "list_task", "get_task", "update_task", "delete_task"} {
		if !names[want] {
			t.Fatalf("missing generic tool %q in %+v", want, names)
		}
	}

	// create_task is hand-authored by the manifest; no generic tool should
	// have been registered under the same name (ListTools would still only
	// show one entry either way, but the declared tool's own params --
	// "title" only, no platform columns -- prove which one is live).
	var createTask *mcp.Tool
	for _, tl := range listed.Tools {
		if tl.Name == "create_task" {
			createTask = tl
		}
	}
	if createTask == nil {
		t.Fatal("create_task missing")
	}
	props, _ := createTask.InputSchema.(map[string]any)["properties"].(map[string]any)
	if _, hasStatus := props["status"]; hasStatus {
		t.Fatalf("create_task exposes %+v, want only the declared \"title\" param -- generic tool must not have shadowed the declared one", props)
	}

	// Generic create_project (no declared tool claims this name) actually
	// creates a row.
	created, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "create_project",
		Arguments: map[string]any{"name": "Home"},
	})
	if err != nil {
		t.Fatalf("call create_project: %v", err)
	}
	if created.IsError {
		t.Fatalf("create_project reported an error: %+v", created.Content)
	}
	projectID, _ := created.StructuredContent.(map[string]any)["id"].(string)
	if projectID == "" {
		t.Fatalf("no id in structured content: %+v", created.StructuredContent)
	}

	listedProjects, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "list_project", Arguments: map[string]any{}})
	if err != nil {
		t.Fatalf("call list_project: %v", err)
	}
	if listedProjects.IsError {
		t.Fatalf("list_project reported an error: %+v", listedProjects.Content)
	}
	rows, _ := listedProjects.StructuredContent.(map[string]any)["data"].([]any)
	if len(rows) != 1 {
		t.Fatalf("list_project rows = %+v, want 1", rows)
	}
}

func TestGenericUpdateIsPartial(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)
	ts := httptest.NewServer(mcpserver.NewServer(reg))
	defer ts.Close()

	session := connect(t, ts.URL+"/mcp/tasks")
	ctx := context.Background()

	created, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "create_task",
		Arguments: map[string]any{"title": "Mow the lawn"},
	})
	if err != nil || created.IsError {
		t.Fatalf("call create_task: err=%v result=%+v", err, created)
	}
	taskID, _ := created.StructuredContent.(map[string]any)["id"].(string)

	updated, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "update_task",
		Arguments: map[string]any{"id": taskID, "status": "done"},
	})
	if err != nil {
		t.Fatalf("call update_task: %v", err)
	}
	if updated.IsError {
		t.Fatalf("update_task reported an error: %+v", updated.Content)
	}
	row, _ := updated.StructuredContent.(map[string]any)
	if row["status"] != "done" {
		t.Fatalf("status = %v, want done", row["status"])
	}
	if row["title"] != "Mow the lawn" {
		t.Fatalf("title = %v, want untouched \"Mow the lawn\"", row["title"])
	}
}

const readonlyNoteManifest = `{
  "app": { "id": "readonly_notes", "name": "Readonly Notes", "version": 1 },
  "entities": [
    { "id": "ent_note", "name": "note", "operations": ["read"], "fields": [
      { "id": "fld_note_text", "name": "text", "type": "text", "required": true }
    ]}
  ]
}`

func TestGenericToolsRespectEntityOperations(t *testing.T) {
	reg := bootApp(t, "readonly_notes", readonlyNoteManifest)
	ts := httptest.NewServer(mcpserver.NewServer(reg))
	defer ts.Close()

	session := connect(t, ts.URL+"/mcp/readonly_notes")
	ctx := context.Background()

	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	names := toolNames(t, listed)

	for _, want := range []string{"list_note", "get_note"} {
		if !names[want] {
			t.Fatalf("missing generic tool %q in %+v", want, names)
		}
	}
	for _, unwanted := range []string{"create_note", "update_note", "delete_note"} {
		if names[unwanted] {
			t.Fatalf("entity note does not allow this operation, %q should not be registered: %+v", unwanted, names)
		}
	}
}
