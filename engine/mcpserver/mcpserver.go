// Package mcpserver is the MCP transport adapter over the tools engine
// (pocketknife/tools): every manifest-declared Tool becomes exactly one MCP
// tool, and a tools/call is one call to tools.Execute. Like api/ over
// domain/, this package does no validation or execution of its own — it only
// translates between the MCP wire shape and the tools engine, one endpoint
// per app at /mcp/{app_id}, resolved fresh from the registry on every
// request so a redeployed app's tool set is visible immediately, with no
// server restart.
package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"pocketknife/domain"
	"pocketknife/registry"
	"pocketknife/schema"
	"pocketknife/tools"
)

// NewServer builds the HTTP handler serving one MCP streamable-HTTP endpoint
// per app at /mcp/{app_id}, exposing every tool that app's current manifest
// declares.
func NewServer(reg *registry.Registry) http.Handler {
	mcpHandler := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		ra, ok := reg.App(r.PathValue("app"))
		if !ok {
			return nil
		}
		return buildServer(reg, ra)
	}, &mcp.StreamableHTTPOptions{Stateless: true})

	mux := http.NewServeMux()
	mux.Handle("/mcp/{app}", requireKnownApp(reg, mcpHandler))
	return mux
}

// requireKnownApp turns an unknown app id into a plain 404 rather than
// letting the MCP SDK's getServer-returned-nil path (a bare 400) be the only
// signal — mirrors how every other per-app route in this binary reports an
// unknown app.
func requireKnownApp(reg *registry.Registry, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		appID := r.PathValue("app")
		if _, ok := reg.App(appID); !ok {
			http.Error(w, "no app with id "+appID, http.StatusNotFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// buildServer constructs a fresh *mcp.Server exposing ra's current tools. It
// is cheap enough to build per session (tool registration is in-memory, no
// I/O), which keeps this in step with build.Deploy's activation model: a
// migrated/redeployed app's tool set changes the moment the registry's
// RegisteredApp does, exactly like assets.NewServer resolving the active
// frontend bundle fresh on every request.
func buildServer(reg *registry.Registry, ra *registry.RegisteredApp) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{
		Name:    ra.Schema.ID,
		Version: fmt.Sprintf("%d", ra.Schema.Version),
	}, nil)

	for _, tool := range ra.Schema.Tools {
		s.AddTool(&mcp.Tool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: inputSchema(tool.Params),
		}, toolHandler(reg, ra.Schema.ID, tool.ID))
	}
	return s
}

// toolHandler returns the mcp.ToolHandler for one declared tool: decode the
// call's raw arguments, run tools.Execute, and translate the outcome into an
// MCP tool result. Tool-level failures (bad params, a step's validation
// failure, a row not found) are reported as CallToolResult.IsError, not as
// protocol errors, so the calling model sees them as something to retry or
// explain rather than a transport fault.
func toolHandler(reg *registry.Registry, appID, toolID string) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var params map[string]json.RawMessage
		if len(req.Params.Arguments) > 0 {
			if err := json.Unmarshal(req.Params.Arguments, &params); err != nil {
				return errorResult("arguments must be a JSON object"), nil
			}
		}

		result, operr := tools.Execute(ctx, reg, appID, toolID, params)
		if operr != nil {
			return errorResult(opErrMessage(operr)), nil
		}

		content := toolResultContent(result)
		payload, err := json.Marshal(content)
		if err != nil {
			return errorResult("could not encode result: " + err.Error()), nil
		}
		return &mcp.CallToolResult{
			Content:           []mcp.Content{&mcp.TextContent{Text: string(payload)}},
			StructuredContent: content,
		}, nil
	}
}

// toolResultContent chooses what a tool call reports back: if the tool
// named any of its steps, the caller gets every named step's row keyed by
// that step's id (e.g. a "workout" read step alongside an "exercises" list
// step both come back), so a caller can see more than just the last step's
// row; an unnamed-steps tool keeps the plain last-step row it always has.
func toolResultContent(result *tools.Result) any {
	if len(result.Steps) == 0 {
		return result.Result
	}
	return result.Steps
}

func errorResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: msg}}}
}

// opErrMessage renders a domain.OpError (and any per-field Issues) as one
// human/LLM-readable string for a tool-error result's content.
func opErrMessage(operr *domain.OpError) string {
	if len(operr.Issues) == 0 {
		return operr.Message
	}
	parts := make([]string, len(operr.Issues))
	for i, iss := range operr.Issues {
		parts[i] = fmt.Sprintf("%s: %s", iss.Field, iss.Message)
	}
	return operr.Message + ": " + strings.Join(parts, "; ")
}

// inputSchema renders a tool's declared params as the JSON Schema object MCP
// clients need to call it correctly. Params share the Field type, so this is
// the same closed type set client.Generate renders to TypeScript — just
// targeting JSON Schema instead.
func inputSchema(params []*schema.Field) map[string]any {
	props := map[string]any{}
	var required []string
	for _, p := range params {
		props[p.Name] = paramSchema(p)
		if p.Required {
			required = append(required, p.Name)
		}
	}
	s := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func paramSchema(p *schema.Field) map[string]any {
	switch p.Type {
	case schema.TypeText:
		m := map[string]any{"type": "string"}
		if p.Min != nil {
			m["minLength"] = *p.Min
		}
		if p.Max != nil {
			m["maxLength"] = *p.Max
		}
		return m
	case schema.TypeDatetime:
		return map[string]any{"type": "string", "format": "date-time"}
	case schema.TypeInteger:
		m := map[string]any{"type": "integer"}
		if p.Min != nil {
			m["minimum"] = *p.Min
		}
		if p.Max != nil {
			m["maximum"] = *p.Max
		}
		return m
	case schema.TypeReal:
		m := map[string]any{"type": "number"}
		if p.Min != nil {
			m["minimum"] = *p.Min
		}
		if p.Max != nil {
			m["maximum"] = *p.Max
		}
		return m
	case schema.TypeBoolean:
		return map[string]any{"type": "boolean"}
	case schema.TypeEnum:
		return map[string]any{"type": "string", "enum": p.Values}
	case schema.TypeReference:
		return map[string]any{"type": "string", "description": "id of a " + p.Target}
	default:
		return map[string]any{}
	}
}
