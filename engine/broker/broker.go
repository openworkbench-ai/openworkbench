// Package broker is the only path a sandboxed function has to a model
// provider. The provider token lives nowhere else: it is read once from the
// environment, held in an unexported field, and never reaches a function or
// the browser. A function that declares the model capability gets to send a
// prompt and get text back — never the token, never a raw provider client.
//
// Status: implemented and tested in isolation; nothing in this binary
// currently constructs a Broker from the environment or wires sandbox/ into
// a live call path. See docs/phase-4-wiring.md.
package broker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ErrNotConfigured is returned when a Broker has no Caller to invoke, e.g. the
// host process was started without a model token.
var ErrNotConfigured = errors.New("broker: no model provider configured")

// Caller is the seam between the Broker and an actual model provider. It
// exists so tests can substitute a stub that never makes a network call,
// without ever needing to hold or see a real token.
type Caller interface {
	Call(ctx context.Context, prompt string) (string, error)
}

// Broker hands sandboxed functions a narrow, prompt-in-text-out capability.
// It never exposes a Caller's credentials: Broker itself holds no token, and
// the only thing it stores is the interface value needed to make the call.
type Broker struct {
	caller Caller
}

// New wraps caller in a Broker. A nil caller is valid: Call then always
// returns ErrNotConfigured, which is the correct behaviour for a host process
// that was started without a model token.
func New(caller Caller) *Broker {
	return &Broker{caller: caller}
}

// Call sends prompt to the configured provider and returns its text
// response. The sandbox is responsible for calling this only after
// confirming the calling function declared the model capability — Call
// itself performs no capability check, because it has no notion of which
// function or app is asking.
func (b *Broker) Call(ctx context.Context, prompt string) (string, error) {
	if b == nil || b.caller == nil {
		return "", ErrNotConfigured
	}
	return b.caller.Call(ctx, prompt)
}

// httpCaller is the real Caller backed by an HTTP model provider. token is
// unexported and has no JSON tag, no String method, and no accessor: nothing
// in this package ever hands it back out.
type httpCaller struct {
	endpoint string
	token    string
	client   *http.Client
}

// NewHTTPCaller builds a Caller that POSTs {"prompt": ...} to endpoint with
// token as a bearer credential and reads back {"text": ...}. endpoint and
// token are typically sourced from the host process's own environment
// (configuration the function never sees) — never from the manifest or any
// function input.
func NewHTTPCaller(endpoint, token string) Caller {
	return &httpCaller{
		endpoint: endpoint,
		token:    token,
		client:   &http.Client{Timeout: 30 * time.Second},
	}
}

type httpCallerRequest struct {
	Prompt string `json:"prompt"`
}

type httpCallerResponse struct {
	Text string `json:"text"`
}

func (c *httpCaller) Call(ctx context.Context, prompt string) (string, error) {
	body, err := json.Marshal(httpCallerRequest{Prompt: prompt})
	if err != nil {
		return "", fmt.Errorf("broker: encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("broker: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("broker: request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("broker: read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("broker: provider returned status %d", resp.StatusCode)
	}

	var out httpCallerResponse
	if err := json.Unmarshal(respBody, &out); err != nil {
		return "", fmt.Errorf("broker: decode response: %w", err)
	}
	return out.Text, nil
}
