package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"pocketknife/domain"
	"pocketknife/registry"
	"pocketknife/schema"
)

// registerGenericCrudTools closes the coverage gap a manifest's own
// hand-authored tools can leave behind: nothing guarantees every entity has
// a tool for every operation it allows (e.g. an app might ship tools for
// creating/listing teams but never expose the underlying player roster). For
// every entity and every operation it allows, this registers a generic
// list_<entity>/get_<entity>/create_<entity>/update_<entity>/delete_<entity>
// tool that calls straight into domain.List/Get/Create/Update/Delete — the
// same reg-resolving functions api/ uses for its generic REST surface, so
// permission enforcement, field coercion and query parsing are identical —
// unless declaredNames already claims that exact name, in which case the
// hand-authored tool wins and no generic tool is registered under it. This
// makes hand-authored, task-shaped tools the preferred path (they're the
// ones an app actually names and describes) while guaranteeing an agent
// always has a raw CRUD fallback, never a hard wall.
func registerGenericCrudTools(s *mcp.Server, reg *registry.Registry, ra *registry.RegisteredApp, declaredNames map[string]bool) {
	appID := ra.Schema.ID
	for _, ent := range ra.Schema.Entities {
		// List shares an entity's read permission rather than a separate
		// grant (schema.go's Operation doc comment) — same gate as get.
		if ent.Allows(schema.OpRead) {
			registerGenericTool(s, declaredNames, "list_"+ent.Name, genericToolDescription("list", ent),
				listInputSchema(), genericListHandler(reg, appID, ent))
			registerGenericTool(s, declaredNames, "get_"+ent.Name, genericToolDescription("get", ent),
				idInputSchema("id of the "+ent.Name+" row to fetch"), genericGetHandler(reg, appID, ent))
		}
		if ent.Allows(schema.OpCreate) {
			registerGenericTool(s, declaredNames, "create_"+ent.Name, genericToolDescription("create", ent),
				inputSchema(ent.Fields), genericCreateHandler(reg, appID, ent))
		}
		if ent.Allows(schema.OpUpdate) {
			registerGenericTool(s, declaredNames, "update_"+ent.Name, genericToolDescription("update", ent),
				updateInputSchema(ent), genericUpdateHandler(reg, appID, ent))
		}
		if ent.Allows(schema.OpDelete) {
			registerGenericTool(s, declaredNames, "delete_"+ent.Name, genericToolDescription("delete", ent),
				idInputSchema("id of the "+ent.Name+" row to delete"), genericDeleteHandler(reg, appID, ent))
		}
	}
}

func registerGenericTool(s *mcp.Server, declaredNames map[string]bool, name, description string, params map[string]any, handler mcp.ToolHandler) {
	if declaredNames[name] {
		return
	}
	s.AddTool(&mcp.Tool{Name: name, Description: description, InputSchema: params}, handler)
}

func genericToolDescription(verb string, ent *schema.Entity) string {
	return fmt.Sprintf(
		"Generic fallback: %s %s row(s) directly. Prefer a more specific tool if the tool list has one for this — use this only when no dedicated tool covers what you need.",
		verb, ent.Name,
	)
}

func idInputSchema(description string) map[string]any {
	return map[string]any{
		"type":       "object",
		"properties": map[string]any{"id": map[string]any{"type": "string", "description": description}},
		"required":   []string{"id"},
	}
}

func listInputSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"filter": map[string]any{
				"type":        "array",
				"items":       map[string]any{"type": "string"},
				"description": `Repeatable "field:op:value" terms, AND-combined (ops: eq/ne/gt/gte/lt/lte/like), e.g. "name:eq:Alice".`,
			},
			"sort": map[string]any{
				"type":        "array",
				"items":       map[string]any{"type": "string"},
				"description": `Field name to sort by, or "-field" for descending. Repeatable.`,
			},
			"limit":  map[string]any{"type": "integer", "description": "Max rows to return (default 50, max 200)."},
			"offset": map[string]any{"type": "integer", "description": "Rows to skip (default 0)."},
		},
	}
}

// updateInputSchema mirrors inputSchema(ent.Fields) but makes every field
// optional (an update only touches the fields it's given) and adds the
// required row id.
func updateInputSchema(ent *schema.Entity) map[string]any {
	props := map[string]any{
		"id": map[string]any{"type": "string", "description": "id of the " + ent.Name + " row to update"},
	}
	for _, f := range ent.Fields {
		props[f.Name] = paramSchema(f)
	}
	return map[string]any{
		"type":                 "object",
		"properties":           props,
		"required":             []string{"id"},
		"additionalProperties": false,
	}
}

func genericListHandler(reg *registry.Registry, appID string, ent *schema.Entity) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args, errRes := decodeToolArgs(req.Params.Arguments)
		if errRes != nil {
			return errRes, nil
		}
		query, errRes := listArgsToQuery(args)
		if errRes != nil {
			return errRes, nil
		}
		result, operr := domain.List(reg, appID, ent.Name, query)
		if operr != nil {
			return errorResult(opErrMessage(operr)), nil
		}
		// Same envelope shape as the generic REST API's list endpoint
		// (engine/api/api.go's handleList) rather than domain.ListResult's
		// raw, capitalized Go field names.
		return marshalToolResult(map[string]any{
			"data":   result.Rows,
			"total":  result.Total,
			"limit":  result.Limit,
			"offset": result.Offset,
		})
	}
}

func genericGetHandler(reg *registry.Registry, appID string, ent *schema.Entity) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args, errRes := decodeToolArgs(req.Params.Arguments)
		if errRes != nil {
			return errRes, nil
		}
		id, errRes := requireStringArg(args, "id")
		if errRes != nil {
			return errRes, nil
		}
		row, operr := domain.Get(reg, appID, ent.Name, id)
		if operr != nil {
			return errorResult(opErrMessage(operr)), nil
		}
		return marshalToolResult(row)
	}
}

func genericCreateHandler(reg *registry.Registry, appID string, ent *schema.Entity) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args, errRes := decodeToolArgs(req.Params.Arguments)
		if errRes != nil {
			return errRes, nil
		}
		row, operr := domain.Create(reg, appID, ent.Name, args)
		if operr != nil {
			return errorResult(opErrMessage(operr)), nil
		}
		return marshalToolResult(row)
	}
}

func genericUpdateHandler(reg *registry.Registry, appID string, ent *schema.Entity) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args, errRes := decodeToolArgs(req.Params.Arguments)
		if errRes != nil {
			return errRes, nil
		}
		id, errRes := requireStringArg(args, "id")
		if errRes != nil {
			return errRes, nil
		}
		delete(args, "id")
		row, operr := domain.Update(reg, appID, ent.Name, id, args)
		if operr != nil {
			return errorResult(opErrMessage(operr)), nil
		}
		return marshalToolResult(row)
	}
}

func genericDeleteHandler(reg *registry.Registry, appID string, ent *schema.Entity) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args, errRes := decodeToolArgs(req.Params.Arguments)
		if errRes != nil {
			return errRes, nil
		}
		id, errRes := requireStringArg(args, "id")
		if errRes != nil {
			return errRes, nil
		}
		deleted, operr := domain.Delete(reg, appID, ent.Name, id)
		if operr != nil {
			return errorResult(opErrMessage(operr)), nil
		}
		return marshalToolResult(map[string]any{"deleted": deleted})
	}
}

func requireStringArg(args map[string]json.RawMessage, name string) (string, *mcp.CallToolResult) {
	raw, ok := args[name]
	if !ok {
		return "", errorResult(`"` + name + `" is required`)
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", errorResult(`"` + name + `" must be a string`)
	}
	return s, nil
}

func listArgsToQuery(args map[string]json.RawMessage) (url.Values, *mcp.CallToolResult) {
	q := url.Values{}
	if raw, ok := args["filter"]; ok {
		var vals []string
		if err := json.Unmarshal(raw, &vals); err != nil {
			return nil, errorResult(`"filter" must be an array of strings`)
		}
		for _, v := range vals {
			q.Add("filter", v)
		}
	}
	if raw, ok := args["sort"]; ok {
		var vals []string
		if err := json.Unmarshal(raw, &vals); err != nil {
			return nil, errorResult(`"sort" must be an array of strings`)
		}
		for _, v := range vals {
			q.Add("sort", v)
		}
	}
	if raw, ok := args["limit"]; ok {
		var n int
		if err := json.Unmarshal(raw, &n); err != nil {
			return nil, errorResult(`"limit" must be an integer`)
		}
		q.Set("limit", strconv.Itoa(n))
	}
	if raw, ok := args["offset"]; ok {
		var n int
		if err := json.Unmarshal(raw, &n); err != nil {
			return nil, errorResult(`"offset" must be an integer`)
		}
		q.Set("offset", strconv.Itoa(n))
	}
	return q, nil
}
