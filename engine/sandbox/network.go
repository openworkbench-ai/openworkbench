package sandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// maxNetworkResponseBytes caps how much of a provider's response body
// network_fetch will buffer and hand back to the guest.
const maxNetworkResponseBytes = 1 << 20

// networkRequest is the wire shape a guest function sends to network_fetch.
type networkRequest struct {
	Host    string            `json:"host"`
	Path    string            `json:"path"`
	Method  string            `json:"method,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

type networkResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body"`
}

// handleNetworkFetch is the capability-gated entry point for a function's
// outbound network access. The allow-list check happens before any request
// is built; a function with no matching domain never reaches the network.
func handleNetworkFetch(ctx context.Context, inv *invocation, reqBytes []byte) ([]byte, int32) {
	var req networkRequest
	if err := json.Unmarshal(reqBytes, &req); err != nil {
		return errorBody(fmt.Sprintf("malformed network request: %v", err)), codeBadRequest
	}
	if !inv.fn.Capabilities.AllowsDomain(req.Host) {
		return nil, codeDenied
	}

	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	// The allow-list is a hostname, not a URL: scheme is host-decided
	// (always https), never guest-decided, so there is no downgrade
	// ambiguity to exploit.
	url := "https://" + req.Host + req.Path

	var body io.Reader
	if req.Body != "" {
		body = strings.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return errorBody(err.Error()), codeBadRequest
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := inv.httpClient().Do(httpReq)
	if err != nil {
		return errorBody(err.Error()), codeBackendError
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxNetworkResponseBytes))
	if err != nil {
		return errorBody(err.Error()), codeBackendError
	}

	headers := map[string]string{}
	for k := range resp.Header {
		headers[k] = resp.Header.Get(k)
	}

	return successBody(networkResponse{Status: resp.StatusCode, Headers: headers, Body: string(respBody)})
}
