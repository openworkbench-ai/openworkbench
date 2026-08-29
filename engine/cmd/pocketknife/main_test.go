package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestRecoverMiddlewareTurnsPanicIntoPlain500 proves a panicking handler
// cannot crash the process (the test process itself would otherwise die) and
// that the client sees only a bare 500 — no stack trace, no panic value.
func TestRecoverMiddlewareTurnsPanicIntoPlain500(t *testing.T) {
	panicking := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom: something went wrong internally")
	})

	srv := httptest.NewServer(recoverMiddleware(panicking))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/anything")
	if err != nil {
		t.Fatalf("request to a panicking handler should still get a response: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusInternalServerError)
	}

	body := make([]byte, 4096)
	n, _ := res.Body.Read(body)
	if strings.Contains(string(body[:n]), "boom") {
		t.Fatalf("panic value leaked to the client response: %q", body[:n])
	}
}

// TestRecoverMiddlewareLeavesNormalRequestsUntouched proves the middleware is
// invisible on the non-panicking path.
func TestRecoverMiddlewareLeavesNormalRequestsUntouched(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("fine"))
	})

	srv := httptest.NewServer(recoverMiddleware(ok))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusTeapot {
		t.Fatalf("status = %d, want %d (middleware must not alter normal responses)", res.StatusCode, http.StatusTeapot)
	}
}

// TestRecoverMiddlewareIsolatesRequests proves one panicking request does not
// affect the handler's ability to serve the next request on the same server.
func TestRecoverMiddlewareIsolatesRequests(t *testing.T) {
	calls := 0
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			panic("first request explodes")
		}
		w.WriteHeader(http.StatusOK)
	})

	srv := httptest.NewServer(recoverMiddleware(h))
	defer srv.Close()

	first, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	first.Body.Close()
	if first.StatusCode != http.StatusInternalServerError {
		t.Fatalf("first request status = %d, want 500", first.StatusCode)
	}

	second, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatalf("second request failed after the first panicked: %v", err)
	}
	defer second.Body.Close()
	if second.StatusCode != http.StatusOK {
		t.Fatalf("second request status = %d, want 200 (server must survive the earlier panic)", second.StatusCode)
	}
}
