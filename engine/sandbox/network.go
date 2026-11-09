package sandbox

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// maxNetworkResponseBytes caps how much of a provider's response body
// network_fetch will buffer and hand back to the guest.
const maxNetworkResponseBytes = 4 << 20

// networkRequest is the wire shape a guest function sends to network_fetch.
type networkRequest struct {
	Host           string            `json:"host"`
	Path           string            `json:"path"`
	Method         string            `json:"method,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
	Body           string            `json:"body,omitempty"`
	BodyBase64     string            `json:"bodyBase64,omitempty"`
	Binary         bool              `json:"binary,omitempty"`
	TimeoutSeconds float64           `json:"timeoutSeconds,omitempty"`
}

type networkResponse struct {
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       string            `json:"body"`
	BodyBase64 string            `json:"bodyBase64,omitempty"`
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
	if req.Path == "" {
		req.Path = "/"
	}
	if !strings.HasPrefix(req.Path, "/") {
		return errorBody("network path must start with /"), codeBadRequest
	}

	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	// The allow-list is a hostname, not a URL: scheme is host-decided
	// (always https), never guest-decided, so there is no downgrade
	// ambiguity to exploit.
	requestURL := "https://" + req.Host + req.Path
	parsed, err := url.Parse(requestURL)
	if err != nil || parsed.Hostname() != req.Host || parsed.User != nil || parsed.Port() != "" {
		return errorBody("invalid network host or path"), codeBadRequest
	}
	if req.TimeoutSeconds > 0 {
		// Cap before duration conversion; the outer invocation deadline always wins.
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(min(req.TimeoutSeconds, 120)*float64(time.Second)))
		defer cancel()
	}

	var body io.Reader
	if req.Body != "" {
		body = strings.NewReader(req.Body)
	}
	if req.BodyBase64 != "" {
		decoded, err := base64.StdEncoding.DecodeString(req.BodyBase64)
		if err != nil {
			return errorBody("invalid base64 request body"), codeBadRequest
		}
		body = bytes.NewReader(decoded)
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, requestURL, body)
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

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxNetworkResponseBytes+1))
	if err != nil {
		return errorBody(err.Error()), codeBackendError
	}
	if len(respBody) > maxNetworkResponseBytes {
		return errorBody("network response exceeds 4 MiB limit"), codeBackendError
	}

	headers := map[string]string{}
	for k := range resp.Header {
		headers[k] = resp.Header.Get(k)
	}

	result := networkResponse{Status: resp.StatusCode, Headers: headers}
	if req.Binary {
		result.BodyBase64 = base64.StdEncoding.EncodeToString(respBody)
	} else {
		result.Body = string(respBody)
	}
	return successBody(result)
}
