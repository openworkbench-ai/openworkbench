package sandbox_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pocketknife/sandbox"
	"pocketknife/schema"
)

func TestPythonNetworkCapability(t *testing.T) {
	requests := 0
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "https://denied.example/steal", 302)
		case "/same":
			http.Redirect(w, r, "https://example.com/ok", 302)
		case "/missing":
			http.Error(w, "missing", 404)
		default:
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			body, _ := io.ReadAll(r.Body)
			if len(body) > 0 {
				w.Write(body)
			} else {
				w.Write([]byte("Grüße"))
			}
		}
	}))
	defer srv.Close()
	transport := newProbeTransport(t, srv)
	defer transport.CloseIdleConnections()
	p := pythonRuntime(t, sandbox.Options{Transport: transport})
	config := sandbox.PythonInvocation{Function: &schema.Function{Capabilities: &schema.Capabilities{Network: []string{"example.com"}}}}
	source := []byte("from urllib.request import urlopen, Request\ndef main(path):\n with urlopen('https://example.com'+path, timeout=2) as r:\n  return {'body': r.read().decode('utf-8'), 'status': r.status, 'type': r.headers.get_content_type()}\n")
	for _, path := range []string{"/ok", "/same"} {
		args, _ := json.Marshal(map[string]string{"path": path})
		res, err := p.Invoke(context.Background(), source, "main", args, config)
		if err != nil || res.Failed {
			t.Fatalf("%s: %v %v", path, res, err)
		}
		var decoded struct {
			Body string `json:"body"`
		}
		if err := json.Unmarshal(res.Output, &decoded); err != nil || decoded.Body != "Grüße" {
			t.Fatalf("decoded response: %s %v", res.Output, err)
		}
	}
	before := requests
	res, err := p.Invoke(context.Background(), source, "main", json.RawMessage(`{"path":"/redirect"}`), config)
	if err != nil || !res.Failed || !strings.Contains(string(res.Output), "denied") || requests != before+1 {
		t.Fatalf("redirect denial: %v %v, requests=%d", res, err, requests-before)
	}
	res, err = p.Invoke(context.Background(), source, "main", json.RawMessage(`{"path":"/missing"}`), config)
	if err != nil || !res.Failed || !strings.Contains(string(res.Output), "404") {
		t.Fatalf("HTTPError: %v %v", res, err)
	}
	post := []byte("from urllib.request import urlopen, Request\ndef main():\n with urlopen(Request('https://example.com/ok', data=bytes([0,255,42]))) as r:\n  return list(r.read())")
	res, err = p.Invoke(context.Background(), post, "main", json.RawMessage(`{}`), config)
	if err != nil || res.Failed || string(res.Output) != "[0, 255, 42]" {
		t.Fatalf("binary request/response: %v %v", res, err)
	}
	// Forging the low-level protocol doesn't grant authority when no capability
	// was supplied by the caller, and path syntax cannot replace the origin.
	before = requests
	forged := []byte("from pocketknife import network_fetch\ndef main(): return network_fetch({'host':'example.com', 'path':'/ok'})")
	res, err = p.Invoke(context.Background(), forged, "main", json.RawMessage(`{}`))
	if err != nil || !res.Failed || requests != before {
		t.Fatalf("forged grant: %v %v", res, err)
	}
	forged = []byte("from pocketknife import network_fetch\ndef main(): return network_fetch({'host':'example.com', 'path':'@denied.example/steal'})")
	res, err = p.Invoke(context.Background(), forged, "main", json.RawMessage(`{}`), config)
	if err != nil || !res.Failed || requests != before {
		t.Fatalf("path origin injection: %v %v", res, err)
	}
}
