package broker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// stubCaller is a Caller test double that records whether it was invoked, so
// tests can assert a call never happened (the capability-denial path) as
// easily as asserting one did.
type stubCaller struct {
	called bool
	text   string
	err    error
}

func (s *stubCaller) Call(ctx context.Context, prompt string) (string, error) {
	s.called = true
	return s.text, s.err
}

func TestCallReturnsErrNotConfiguredWithNoCaller(t *testing.T) {
	b := New(nil)
	_, err := b.Call(context.Background(), "hello")
	if err != ErrNotConfigured {
		t.Fatalf("expected ErrNotConfigured, got %v", err)
	}
}

func TestNilBrokerReturnsErrNotConfigured(t *testing.T) {
	var b *Broker
	_, err := b.Call(context.Background(), "hello")
	if err != ErrNotConfigured {
		t.Fatalf("expected ErrNotConfigured from a nil broker, got %v", err)
	}
}

func TestCallDelegatesToCaller(t *testing.T) {
	stub := &stubCaller{text: "a model response"}
	b := New(stub)

	got, err := b.Call(context.Background(), "hello")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !stub.called {
		t.Fatalf("expected the underlying caller to be invoked")
	}
	if got != "a model response" {
		t.Fatalf("expected delegated response, got %q", got)
	}
}

// TestBrokerNeverExposesToken builds a real httpCaller with a known secret
// token and confirms that JSON-encoding it — the only serialization path
// anything in this codebase actually uses (every API response goes through
// encoding/json) — never surfaces the token. This is the structural half of
// the "token never reaches a function or the browser" requirement; the
// dynamic half (a guest function's observable output never contains the
// token) is exercised by the sandbox package's end-to-end tests.
func TestBrokerNeverExposesToken(t *testing.T) {
	const secret = "sk-super-secret-token-do-not-leak"
	caller := NewHTTPCaller("https://example.invalid/v1/complete", secret)
	b := New(caller)

	if j, err := json.Marshal(b); err == nil && strings.Contains(string(j), secret) {
		t.Fatalf("json.Marshal(broker) leaked the token: %s", j)
	}
	if j, err := json.Marshal(caller); err == nil && strings.Contains(string(j), secret) {
		t.Fatalf("json.Marshal(caller) leaked the token: %s", j)
	}
}

func TestHTTPCallerSendsBearerTokenAndDecodesResponse(t *testing.T) {
	const secret = "sk-test-token"
	var gotAuth, gotPrompt string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		var body httpCallerRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotPrompt = body.Prompt
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(httpCallerResponse{Text: "echo: " + body.Prompt})
	}))
	defer srv.Close()

	caller := NewHTTPCaller(srv.URL, secret)
	got, err := caller.Call(context.Background(), "ping")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotAuth != "Bearer "+secret {
		t.Fatalf("expected bearer token in request, got %q", gotAuth)
	}
	if gotPrompt != "ping" {
		t.Fatalf("expected prompt to reach the provider, got %q", gotPrompt)
	}
	if got != "echo: ping" {
		t.Fatalf("unexpected response: %q", got)
	}
}

func TestHTTPCallerNonOKStatusIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	caller := NewHTTPCaller(srv.URL, "irrelevant")
	if _, err := caller.Call(context.Background(), "ping"); err == nil {
		t.Fatalf("expected an error for a non-200 provider response")
	}
}
