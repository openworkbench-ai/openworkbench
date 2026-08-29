package sandbox

import (
	"context"
	"encoding/json"
	"fmt"
)

// modelRequest is the wire shape a guest function sends to model_call.
type modelRequest struct {
	Prompt string `json:"prompt"`
}

type modelResponse struct {
	Text string `json:"text"`
}

// handleModelCall is the capability-gated entry point for a function's
// access to the model broker. The capability check happens before the
// broker is ever touched: a function that did not declare the model
// capability never reaches broker.Call, and so never has any path — direct
// or indirect — to the provider token the broker holds.
func handleModelCall(ctx context.Context, inv *invocation, reqBytes []byte) ([]byte, int32) {
	var req modelRequest
	if err := json.Unmarshal(reqBytes, &req); err != nil {
		return errorBody(fmt.Sprintf("malformed model request: %v", err)), codeBadRequest
	}
	if inv.fn.Capabilities == nil || !inv.fn.Capabilities.Model {
		return nil, codeDenied
	}

	text, err := inv.broker.Call(ctx, req.Prompt)
	if err != nil {
		// The function did declare the capability, so a broker failure here
		// is an infrastructure problem, not a permission one.
		return errorBody(err.Error()), codeBackendError
	}

	return successBody(modelResponse{Text: text})
}
