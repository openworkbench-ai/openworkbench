package sandbox_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pocketknife/sandbox"
)

func pythonRuntime(t *testing.T, opts sandbox.Options) *sandbox.Python {
	t.Helper()
	dir := os.Getenv("POCKETKNIFE_PYTHON_DIR")
	if dir == "" {
		dir = filepath.Join("..", ".python-wasm")
	}
	if _, err := os.Stat(filepath.Join(dir, "python.wasm")); err != nil {
		t.Skip("run scripts/setup-python-wasm.sh to enable real Python/Wasm integration tests")
	}
	p, err := sandbox.NewPython(context.Background(), dir, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close(context.Background()) })
	return p
}

func TestPythonWasm(t *testing.T) {
	p := pythonRuntime(t, sandbox.Options{})
	tests := []struct {
		name, source, handler, args, want string
		failed                            bool
	}{
		{"kwargs and stdlib", "import math\ndef calculate(a, b=2):\n print('diagnostic')\n return {'sum': a+b, 'root': math.sqrt(16)}", "calculate", `{"a":5}`, `{"sum":7,"root":4}`, false},
		{"default handler", "def main(): return [1, True, None]", "", `{}`, `[1,true,null]`, false},
		{"sleep", "import time\ndef main():\n start=time.monotonic()\n time.sleep(0.05)\n return time.monotonic()-start >= 0.04", "main", `{}`, `true`, false},
		{"exception", "def main(): raise ValueError('bad argument')", "main", `{}`, `{"error":"ValueError: bad argument"}`, true},
		{"syntax error", "def main(:", "main", `{}`, "SyntaxError", true},
		{"missing handler", "def other(): pass", "main", `{}`, "not callable", true},
		{"non JSON return", "def main(): return {1, 2}", "main", `{}`, "not JSON serializable", true},
		{"non finite", "def main(): return float('nan')", "main", `{}`, "JSON compliant", true},
		{"no host env", "import os\ndef main(): return os.environ.get('OPENWORKBENCH_TEST_SECRET')", "main", `{}`, `null`, false},
		{"no host files", "def main(): return open('/etc/passwd').read()", "main", `{}`, "Error", true},
		{"no writes", "def main(): return open('/python/lib/owned', 'w')", "main", `{}`, "Error", true},
		{"no processes", "import os\ndef main(): return os.system('echo escaped')", "main", `{}`, "Error", true},
		{"no network", "import socket\ndef main(): return socket.create_connection(('example.com', 443))", "main", `{}`, "Error", true},
		{"isolated state", "counter = 0\ndef main():\n global counter\n counter += 1\n return counter", "main", `{}`, `1`, false},
	}
	example, err := os.ReadFile(filepath.Join("..", "..", "examples", "python_calculator", "functions", "total.py"))
	if err != nil {
		t.Fatal(err)
	}
	res, err := p.Invoke(context.Background(), example, "calculate_total", json.RawMessage(`{"price":12.5,"quantity":3,"discount_percent":10}`))
	if err != nil || res.Failed || !strings.Contains(string(res.Output), `33.75`) {
		t.Fatalf("example: %v %v", res, err)
	}
	t.Setenv("OPENWORKBENCH_TEST_SECRET", "must not reach guest")
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := p.Invoke(context.Background(), []byte(tt.source), tt.handler, json.RawMessage(tt.args))
			if err != nil {
				t.Fatal(err)
			}
			if res.Failed != tt.failed {
				t.Fatalf("failed=%v output=%s", res.Failed, res.Output)
			}
			var got, want any
			if json.Unmarshal([]byte(tt.want), &want) == nil {
				if err := json.Unmarshal(res.Output, &got); err != nil {
					t.Fatal(err)
				}
				g, _ := json.Marshal(got)
				w, _ := json.Marshal(want)
				if string(g) != string(w) {
					t.Fatalf("got %s want %s", g, w)
				}
			} else if !strings.Contains(string(res.Output), tt.want) {
				t.Fatalf("output=%s want %s", res.Output, tt.want)
			}
		})
	}
	// Concurrent calls use the compiled interpreter, never a shared namespace.
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Go(func() {
			res, err := p.Invoke(context.Background(), []byte(tests[len(tests)-1].source), "main", json.RawMessage(`{}`))
			if err != nil || res == nil || string(res.Output) != "1" {
				t.Errorf("isolated invocation: %v %v", res, err)
			}
		})
	}
	wg.Wait()
}

func TestPythonWasmLimits(t *testing.T) {
	p := pythonRuntime(t, sandbox.Options{Timeout: 2 * time.Second, MaxOutputBytes: 1024})
	_, err := p.Invoke(context.Background(), []byte("def main():\n while True: pass"), "main", json.RawMessage(`{}`))
	if !errors.Is(err, sandbox.ErrTimeout) {
		t.Fatalf("loop: %v", err)
	}
	started := time.Now()
	_, err = p.Invoke(context.Background(), []byte("import time\ndef main(): time.sleep(10)"), "main", json.RawMessage(`{}`))
	if !errors.Is(err, sandbox.ErrTimeout) || time.Since(started) > 8*time.Second {
		t.Fatalf("sleep did not respect invocation deadline: elapsed=%s error=%v", time.Since(started), err)
	}
	_, err = p.Invoke(context.Background(), []byte("def main(): return 'x'*10000"), "main", json.RawMessage(`{}`))
	if !errors.Is(err, sandbox.ErrResourceExhausted) {
		t.Fatalf("output limit: %v", err)
	}
	res, err := p.Invoke(context.Background(), []byte("def main(): return bytearray(256*1024*1024)"), "main", json.RawMessage(`{}`))
	if err != nil || !res.Failed || !strings.Contains(string(res.Output), "MemoryError") {
		t.Fatalf("memory limit: %v %v", res, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = p.Invoke(ctx, []byte("def main(): return 1"), "main", json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("canceled invocation succeeded")
	}
}
