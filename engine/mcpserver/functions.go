package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"pocketknife/domain"
	"pocketknife/registry"
	"pocketknife/schema"
	"pocketknife/tools"
)

func executeFunction(ctx context.Context, executor FunctionExecutor, ra *registry.RegisteredApp, tool *schema.Tool, params map[string]json.RawMessage) (*mcp.CallToolResult, error) {
	if executor == nil {
		return errorResult("function execution is not configured"), nil
	}
	fn := ra.Schema.FunctionByID(tool.Function)
	if fn == nil {
		return errorResult("function no longer exists"), nil
	}
	values, issues := tools.ResolveParams(ra.Schema, ra.Store, tool, params)
	if len(issues) > 0 {
		return errorResult(opErrMessage(&domain.OpError{Message: "tool params failed validation", Issues: issues})), nil
	}
	// Preserve Python callable defaults when an optional argument is omitted.
	for _, p := range tool.Params {
		if _, present := params[p.Name]; !present && !p.HasDefault && !p.Required {
			delete(values, p.Name)
		}
	}
	input, err := json.Marshal(values)
	if err != nil {
		return errorResult("could not encode function arguments"), nil
	}
	result, err := executor.Invoke(ctx, ra, fn, input)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	if result.Failed {
		return errorResult(string(result.Output)), nil
	}
	var output any
	if !json.Valid(result.Output) {
		return errorResult("function output must be valid JSON"), nil
	}
	decoder := json.NewDecoder(bytes.NewReader(result.Output))
	decoder.UseNumber()
	if err := decoder.Decode(&output); err != nil {
		return errorResult("function output must be valid JSON"), nil
	}
	// MCP structuredContent is an object. Preserve objects directly and wrap
	// Python scalar/list/null return values in a consistent result envelope.
	if _, ok := output.(map[string]any); !ok {
		output = map[string]any{"result": output}
	}
	return marshalToolResult(output)
}
