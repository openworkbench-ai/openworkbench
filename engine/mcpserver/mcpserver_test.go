package mcpserver_test

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"pocketknife/mcpserver"
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

const tasksManifest = `{
  "app": { "id": "tasks", "name": "Tasks", "version": 1 },
  "entities": [
    { "id": "ent_project", "name": "project", "fields": [
      { "id": "fld_pname", "name": "name", "type": "text", "required": true }
    ]},
    { "id": "ent_task", "name": "task", "fields": [
      { "id": "fld_title",  "name": "title",  "type": "text", "required": true },
      { "id": "fld_status", "name": "status", "type": "enum", "values": ["planned", "done"], "default": "planned" },
      { "id": "fld_project", "name": "project", "type": "reference", "target": "ent_project" }
    ]}
  ],
  "tools": [
    {
      "id": "tool_create_task",
      "name": "create_task",
      "description": "Create a task",
      "params": [
        { "id": "p_title", "name": "title", "type": "text", "required": true }
      ],
      "steps": [
        { "op": "create", "entity": "ent_task", "set": { "title": "$params.title" } }
      ]
    },
    {
      "id": "tool_mark_done",
      "name": "mark_task_done",
      "description": "Mark a task done",
      "params": [
        { "id": "p_id", "name": "task_id", "type": "reference", "target": "ent_task", "required": true }
      ],
      "steps": [
        { "op": "update", "entity": "ent_task", "rowId": "$params.task_id", "set": { "status": "done" } }
      ]
    },
    {
      "id": "tool_create_task_named",
      "name": "create_task_named",
      "description": "Create a project, then a task inside it, with both steps named",
      "params": [
        { "id": "p_name", "name": "project_name", "type": "text", "required": true },
        { "id": "p_title2", "name": "title", "type": "text", "required": true }
      ],
      "steps": [
        { "id": "project", "op": "create", "entity": "ent_project", "set": { "name": "$params.project_name" } },
        { "id": "task", "op": "create", "entity": "ent_task", "set": { "title": "$params.title", "project": "$steps.project.id" } }
      ]
    }
  ]
}`

func connect(t *testing.T, url string) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v0"}, nil)
	session, err := client.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: url}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { session.Close() })
	return session
}

func TestUnknownAppReturns404(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)
	ts := httptest.NewServer(mcpserver.NewServer(reg))
	defer ts.Close()

	resp, err := ts.Client().Get(ts.URL + "/mcp/no_such_app")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func TestListToolsAndCall(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)
	ts := httptest.NewServer(mcpserver.NewServer(reg))
	defer ts.Close()

	session := connect(t, ts.URL+"/mcp/tasks")
	ctx := context.Background()

	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	if len(listed.Tools) != 3 {
		t.Fatalf("got %d tools, want 3", len(listed.Tools))
	}
	names := map[string]bool{}
	for _, tl := range listed.Tools {
		names[tl.Name] = true
	}
	if !names["create_task"] || !names["mark_task_done"] {
		t.Fatalf("unexpected tool set: %+v", names)
	}

	created, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "create_task",
		Arguments: map[string]any{"title": "Mow the lawn"},
	})
	if err != nil {
		t.Fatalf("call create_task: %v", err)
	}
	if created.IsError {
		t.Fatalf("create_task reported an error: %+v", created.Content)
	}
	taskID, _ := created.StructuredContent.(map[string]any)["id"].(string)
	if taskID == "" {
		t.Fatalf("no id in structured content: %+v", created.StructuredContent)
	}

	done, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "mark_task_done",
		Arguments: map[string]any{"task_id": taskID},
	})
	if err != nil {
		t.Fatalf("call mark_task_done: %v", err)
	}
	if done.IsError {
		t.Fatalf("mark_task_done reported an error: %+v", done.Content)
	}
	if status := done.StructuredContent.(map[string]any)["status"]; status != "done" {
		t.Fatalf("status = %v, want done", status)
	}
}

func TestToolUIResourceIsAdvertisedAndServed(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "reading_tracker")
	if err := os.MkdirAll(filepath.Join(dir, "ui"), 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{
      "app": { "id": "reading_tracker", "name": "Reading Tracker", "version": 1 },
      "entities": [
        { "id": "ent_book", "name": "book", "fields": [
          { "id": "fld_title", "name": "title", "type": "text", "required": true }
        ]}
      ],
      "tools": [
        { "id": "tool_create_book", "name": "create_book",
          "params": [ { "id": "p_title", "name": "title", "type": "text", "required": true } ],
          "steps": [ { "op": "create", "entity": "ent_book", "set": { "title": "$params.title" } } ],
          "ui": { "component": "Book" }
        }
      ]
    }`
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	const bookHTML = "<!doctype html><html><body>Book component</body></html>"
	if err := os.WriteFile(filepath.Join(dir, "ui", "Book.html"), []byte(bookHTML), 0o644); err != nil {
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

	ts := httptest.NewServer(mcpserver.NewServer(reg))
	defer ts.Close()

	session := connect(t, ts.URL+"/mcp/reading_tracker")
	ctx := context.Background()

	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	var createBook *mcp.Tool
	for _, tl := range listed.Tools {
		if tl.Name == "create_book" {
			createBook = tl
		}
	}
	if createBook == nil {
		t.Fatal("create_book tool missing")
	}
	ui, _ := createBook.Meta["ui"].(map[string]any)
	if ui == nil {
		t.Fatalf("tool has no _meta.ui: %+v", createBook.Meta)
	}
	resourceURI, _ := ui["resourceUri"].(string)
	if resourceURI != "ui://reading_tracker/Book.html" {
		t.Fatalf("resourceUri = %q, want ui://reading_tracker/Book.html", resourceURI)
	}

	read, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: resourceURI})
	if err != nil {
		t.Fatalf("read resource: %v", err)
	}
	if len(read.Contents) != 1 {
		t.Fatalf("got %d contents, want 1", len(read.Contents))
	}
	if read.Contents[0].MIMEType != "text/html;profile=mcp-app" {
		t.Fatalf("mimeType = %q, want text/html;profile=mcp-app", read.Contents[0].MIMEType)
	}
	if read.Contents[0].Text != bookHTML {
		t.Fatalf("resource text = %q, want %q", read.Contents[0].Text, bookHTML)
	}
}

func TestCallToolWithNamedStepsReturnsEveryStep(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)
	ts := httptest.NewServer(mcpserver.NewServer(reg))
	defer ts.Close()

	session := connect(t, ts.URL+"/mcp/tasks")
	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "create_task_named",
		Arguments: map[string]any{"project_name": "Home", "title": "Mow the lawn"},
	})
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if res.IsError {
		t.Fatalf("create_task_named reported an error: %+v", res.Content)
	}

	content, ok := res.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("structured content is not a map: %#v", res.StructuredContent)
	}
	project, ok := content["project"].(map[string]any)
	if !ok || project["name"] != "Home" {
		t.Fatalf("project step = %#v", content["project"])
	}
	task, ok := content["task"].(map[string]any)
	if !ok || task["title"] != "Mow the lawn" || task["project"] != project["id"] {
		t.Fatalf("task step = %#v", content["task"])
	}
}

func TestCallToolWithMissingRequiredParamIsToolError(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)
	ts := httptest.NewServer(mcpserver.NewServer(reg))
	defer ts.Close()

	session := connect(t, ts.URL+"/mcp/tasks")
	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "create_task",
		Arguments: map[string]any{},
	})
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected a tool-level error for a missing required param, got: %+v", res.StructuredContent)
	}
}
