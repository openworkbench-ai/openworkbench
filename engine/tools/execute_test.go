package tools_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"pocketknife/domain"
	"pocketknife/registry"
	"pocketknife/tools"
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

func rawParams(m map[string]any) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(m))
	for k, v := range m {
		b, _ := json.Marshal(v)
		out[k] = b
	}
	return out
}

const tasksManifest = `{
  "app": { "id": "tasks", "name": "Tasks", "version": 1 },
  "entities": [
    { "id": "ent_project", "name": "project", "fields": [
      { "id": "fld_pname", "name": "name", "type": "text", "required": true, "unique": true }
    ]},
    { "id": "ent_task", "name": "task", "fields": [
      { "id": "fld_title",   "name": "title",   "type": "text", "required": true },
      { "id": "fld_status",  "name": "status",  "type": "enum", "values": ["planned", "done"], "default": "planned" },
      { "id": "fld_project", "name": "project", "type": "reference", "target": "ent_project" }
    ]}
  ],
  "tools": [
    {
      "id": "tool_mark_done",
      "name": "mark_task_done",
      "description": "Mark a task as done",
      "params": [
        { "id": "p_task_id", "name": "task_id", "type": "reference", "target": "ent_task", "required": true }
      ],
      "steps": [
        { "id": "updated", "op": "update", "entity": "ent_task", "rowId": "$params.task_id", "set": { "status": "done" } }
      ]
    },
    {
      "id": "tool_new_project_task",
      "name": "new_project_task",
      "description": "Create a project, then a task inside it",
      "params": [
        { "id": "p_project_name", "name": "project_name", "type": "text", "required": true },
        { "id": "p_title", "name": "title", "type": "text", "required": true }
      ],
      "steps": [
        { "id": "project", "op": "create", "entity": "ent_project", "set": { "name": "$params.project_name" } },
        { "id": "task", "op": "create", "entity": "ent_task", "set": { "title": "$params.title", "project": "$steps.project.id" } }
      ]
    },
    {
      "id": "tool_fail_second_step",
      "name": "fail_second_step",
      "description": "First step succeeds, second step always fails validation - proves atomicity",
      "params": [
        { "id": "p_name2", "name": "project_name", "type": "text", "required": true }
      ],
      "steps": [
        { "id": "project", "op": "create", "entity": "ent_project", "set": { "name": "$params.project_name" } },
        { "id": "task", "op": "create", "entity": "ent_task", "set": { "project": "$steps.project.id" } }
      ]
    },
    {
      "id": "tool_list_tasks",
      "name": "list_tasks",
      "description": "List all tasks",
      "steps": [
        { "op": "list", "entity": "ent_task" }
      ]
    },
    {
      "id": "tool_list_tasks_in_project",
      "name": "list_tasks_in_project",
      "description": "List only the tasks belonging to one project",
      "params": [
        { "id": "p_project_id", "name": "project_id", "type": "reference", "target": "ent_project", "required": true }
      ],
      "steps": [
        { "op": "list", "entity": "ent_task", "filter": { "project": "$params.project_id" } }
      ]
    },
    {
      "id": "tool_read_project",
      "name": "read_project",
      "description": "Read a project together with its tasks",
      "params": [
        { "id": "p_read_project_id", "name": "project_id", "type": "reference", "target": "ent_project", "required": true }
      ],
      "steps": [
        { "id": "project", "op": "read", "entity": "ent_project", "rowId": "$params.project_id" },
        { "id": "tasks", "op": "list", "entity": "ent_task", "filter": { "project": "$steps.project.id" } }
      ]
    }
  ]
}`

func TestExecuteSingleStepUpdate(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)

	task, operr := domain.Create(reg, "tasks", "task", map[string]json.RawMessage{"title": json.RawMessage(`"Mow"`)})
	if operr != nil {
		t.Fatalf("seed task: %+v", operr)
	}
	taskID := task["id"].(string)

	res, operr := tools.Execute(context.Background(), reg, "tasks", "mark_task_done", rawParams(map[string]any{"task_id": taskID}))
	if operr != nil {
		t.Fatalf("execute: %+v", operr)
	}
	if res.Result["status"] != "done" {
		t.Fatalf("result status = %v, want done", res.Result["status"])
	}

	got, operr := domain.Get(reg, "tasks", "task", taskID)
	if operr != nil {
		t.Fatalf("get: %+v", operr)
	}
	if got["status"] != "done" {
		t.Fatalf("persisted status = %v, want done", got["status"])
	}
}

func TestExecuteResolvesUnknownTool(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)
	_, operr := tools.Execute(context.Background(), reg, "tasks", "no_such_tool", nil)
	if operr == nil || operr.Kind != domain.ErrToolNotFound {
		t.Fatalf("expected ErrToolNotFound, got %+v", operr)
	}
}

func TestExecuteMultiStepChaining(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)

	res, operr := tools.Execute(context.Background(), reg, "tasks", "new_project_task", rawParams(map[string]any{
		"project_name": "Home",
		"title":        "Mow the lawn",
	}))
	if operr != nil {
		t.Fatalf("execute: %+v", operr)
	}
	task := res.Result
	if task["title"] != "Mow the lawn" {
		t.Fatalf("task title = %v", task["title"])
	}
	projectID, _ := res.Steps["project"]["id"].(string)
	if projectID == "" || task["project"] != projectID {
		t.Fatalf("task.project = %v, want project id %v", task["project"], projectID)
	}

	// The project row created by step 1 must actually be committed.
	got, operr := domain.Get(reg, "tasks", "project", projectID)
	if operr != nil {
		t.Fatalf("get project: %+v", operr)
	}
	if got["name"] != "Home" {
		t.Fatalf("project name = %v", got["name"])
	}
}

func TestExecuteRollsBackOnLaterStepFailure(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)

	_, operr := tools.Execute(context.Background(), reg, "tasks", "fail_second_step", rawParams(map[string]any{
		"project_name": "Orphan",
	}))
	if operr == nil {
		t.Fatalf("expected the second step (missing required title) to fail")
	}

	res, opErr2 := domain.List(reg, "tasks", "project", map[string][]string{"filter": {"name:eq:Orphan"}})
	if opErr2 != nil {
		t.Fatalf("list projects: %+v", opErr2)
	}
	if res.Total != 0 {
		t.Fatalf("project from the failed tool call was not rolled back: found %d matching rows", res.Total)
	}
}

func TestExecuteListStep(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)

	for _, title := range []string{"Mow", "Rake", "Water"} {
		if _, operr := domain.Create(reg, "tasks", "task", rawParams(map[string]any{"title": title})); operr != nil {
			t.Fatalf("seed task %q: %+v", title, operr)
		}
	}

	res, operr := tools.Execute(context.Background(), reg, "tasks", "list_tasks", nil)
	if operr != nil {
		t.Fatalf("execute: %+v", operr)
	}
	if total, _ := res.Result["total"].(int); total != 3 {
		t.Fatalf("total = %v, want 3", res.Result["total"])
	}
	rows, ok := res.Result["rows"].([]map[string]any)
	if !ok || len(rows) != 3 {
		t.Fatalf("rows = %#v", res.Result["rows"])
	}
}

func TestExecuteListStepWithFilterOnParam(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)

	home, operr := domain.Create(reg, "tasks", "project", rawParams(map[string]any{"name": "Home"}))
	if operr != nil {
		t.Fatalf("seed project: %+v", operr)
	}
	work, operr := domain.Create(reg, "tasks", "project", rawParams(map[string]any{"name": "Work"}))
	if operr != nil {
		t.Fatalf("seed project: %+v", operr)
	}
	homeID, workID := home["id"].(string), work["id"].(string)

	for _, tc := range []struct{ title, project string }{
		{"Mow", homeID}, {"Rake", homeID}, {"Ship it", workID},
	} {
		if _, operr := domain.Create(reg, "tasks", "task", rawParams(map[string]any{"title": tc.title, "project": tc.project})); operr != nil {
			t.Fatalf("seed task %q: %+v", tc.title, operr)
		}
	}

	res, operr := tools.Execute(context.Background(), reg, "tasks", "list_tasks_in_project", rawParams(map[string]any{"project_id": homeID}))
	if operr != nil {
		t.Fatalf("execute: %+v", operr)
	}
	if total, _ := res.Result["total"].(int); total != 2 {
		t.Fatalf("total = %v, want 2", res.Result["total"])
	}
	rows, ok := res.Result["rows"].([]map[string]any)
	if !ok || len(rows) != 2 {
		t.Fatalf("rows = %#v", res.Result["rows"])
	}
	for _, row := range rows {
		if row["project"] != homeID {
			t.Fatalf("row from wrong project leaked through filter: %#v", row)
		}
	}
}

func TestExecuteListStepWithFilterOnPriorStep(t *testing.T) {
	reg := bootApp(t, "tasks", tasksManifest)

	project, operr := domain.Create(reg, "tasks", "project", rawParams(map[string]any{"name": "Garden"}))
	if operr != nil {
		t.Fatalf("seed project: %+v", operr)
	}
	projectID := project["id"].(string)
	if _, operr := domain.Create(reg, "tasks", "task", rawParams(map[string]any{"title": "Weed", "project": projectID})); operr != nil {
		t.Fatalf("seed task: %+v", operr)
	}
	other, operr := domain.Create(reg, "tasks", "project", rawParams(map[string]any{"name": "Other"}))
	if operr != nil {
		t.Fatalf("seed project: %+v", operr)
	}
	if _, operr := domain.Create(reg, "tasks", "task", rawParams(map[string]any{"title": "Unrelated", "project": other["id"].(string)})); operr != nil {
		t.Fatalf("seed task: %+v", operr)
	}

	res, operr := tools.Execute(context.Background(), reg, "tasks", "read_project", rawParams(map[string]any{"project_id": projectID}))
	if operr != nil {
		t.Fatalf("execute: %+v", operr)
	}
	if res.Steps["project"]["name"] != "Garden" {
		t.Fatalf("project step = %#v", res.Steps["project"])
	}
	if total, _ := res.Steps["tasks"]["total"].(int); total != 1 {
		t.Fatalf("tasks total = %v, want 1", res.Steps["tasks"]["total"])
	}
	rows, ok := res.Steps["tasks"]["rows"].([]map[string]any)
	if !ok || len(rows) != 1 || rows[0]["title"] != "Weed" {
		t.Fatalf("tasks rows = %#v", res.Steps["tasks"]["rows"])
	}
}
