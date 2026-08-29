package cors_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"pocketknife/cors"
)

func TestDisabledIsANoop(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true })
	h := cors.Middleware(false, next)

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if !called {
		t.Fatal("disabled middleware must still call next")
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("disabled middleware must not set CORS headers")
	}
}

func TestEnabledSetsHeadersAndShortCircuitsOptions(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true })
	h := cors.Middleware(true, next)

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if !called {
		t.Fatal("enabled middleware must call next for a normal request")
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("Access-Control-Allow-Origin = %q", w.Header().Get("Access-Control-Allow-Origin"))
	}

	called = false
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodOptions, "/", nil))
	if called {
		t.Fatal("an OPTIONS preflight must be short-circuited, not passed to next")
	}
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 for a preflight", w.Code)
	}
}
