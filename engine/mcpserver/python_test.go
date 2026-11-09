package mcpserver_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"pocketknife/adminapi"
	"pocketknife/functions"
	"pocketknife/mcpserver"
	"pocketknife/pythonpackages"
	"pocketknife/registry"
)

const pythonAppManifest = `{
 "app":{"id":"calculator","name":"Calculator","version":1},
 "entities":[{"id":"ent_note","name":"note","fields":[{"id":"f_text","name":"text","type":"text"}]}],
 "functions":[{"id":"fn_add","name":"add","runtime":"python","entry":"functions/add.py","handler":"calculate","capabilities":{}}],
 "tools":[{"id":"tool_add","name":"add","description":"Add two numbers using Python","function":"fn_add","params":[
 {"id":"p_a","name":"a","type":"integer","required":true},
 {"id":"p_b","name":"b","type":"integer"}]}]
}`

func TestPythonToolSaveInstallAndCall(t *testing.T) {
	pythonDir := os.Getenv("POCKETKNIFE_PYTHON_DIR")
	if pythonDir == "" {
		pythonDir = filepath.Join("..", ".python-wasm")
	}
	if _, err := os.Stat(filepath.Join(pythonDir, "python.wasm")); err != nil {
		t.Skip("run scripts/setup-python-wasm.sh")
	}
	reg := registry.New()
	t.Cleanup(func() { reg.Close() })
	catalog, data := t.TempDir(), t.TempDir()
	executor, err := functions.New(pythonDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { executor.Close(context.Background()) })
	mux := http.NewServeMux()
	mux.Handle("/admin/", adminapi.NewServer(reg, catalog, data))
	mux.Handle("/mcp/", mcpserver.NewServer(reg, executor))
	ts := httptest.NewServer(mux)
	defer ts.Close()
	request := func(method, path string, body any) {
		t.Helper()
		var r io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			r = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, ts.URL+path, r)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 {
			t.Fatalf("%s %s: %d %s", method, path, res.StatusCode, b)
		}
	}
	save := func(source string) {
		request("PUT", "/admin/apps/calculator", map[string]any{
			"manifest":      json.RawMessage(pythonAppManifest),
			"functionFiles": []map[string]string{{"path": "functions/add.py", "content": source}},
		})
		request("POST", "/admin/apps/calculator/install", nil)
	}
	save("def calculate(a, b=10):\n print('hello')\n return {'sum': a+b}\n")
	session := connect(t, ts.URL+"/mcp/calculator")
	listed, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, tool := range listed.Tools {
		if tool.Name == "add" {
			found = true
		}
	}
	if !found {
		t.Fatal("Python tool not discoverable")
	}
	call := func(args map[string]any) *mcp.CallToolResult {
		t.Helper()
		result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "add", Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	for _, tt := range []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"a": 5, "b": 7}, `{"sum":12}`},
		{map[string]any{"a": 5}, `{"sum":15}`},
	} {
		res := call(tt.args)
		if res.IsError || res.Content[0].(*mcp.TextContent).Text != tt.want {
			t.Fatalf("call: %+v", res)
		}
		if res.StructuredContent == nil {
			t.Fatal("missing structured result")
		}
	}
	for _, args := range []map[string]any{{}, {"a": "bad"}, {"a": 1, "undeclared": true}} {
		if res := call(args); !res.IsError {
			t.Fatalf("invalid args accepted: %+v", res)
		}
	}
	// Source is loaded fresh after reinstall; no stale path-based code cache.
	save("def calculate(a, b=10): return a*b\n")
	if res := call(map[string]any{"a": 3, "b": 4}); res.IsError || res.Content[0].(*mcp.TextContent).Text != `{"result":12}` {
		t.Fatalf("updated function: %+v", res)
	}
	save("def calculate(a, b=10): return 9007199254740993\n")
	if res := call(map[string]any{"a": 1}); res.IsError || res.Content[0].(*mcp.TextContent).Text != `{"result":9007199254740993}` {
		t.Fatalf("integer precision: %+v", res)
	}
	save("def calculate(a, b=10): raise ValueError('cannot calculate')\n")
	res := call(map[string]any{"a": 1})
	if !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "cannot calculate") {
		t.Fatalf("exception result: %+v", res)
	}
	// Packages use a generic wheel bundle, including metadata and package data.
	var wheel bytes.Buffer
	writer := zip.NewWriter(&wheel)
	for name, content := range map[string]string{
		"demo_helpers/__init__.py":            "def combine(a,b): return a+b+100\n",
		"demo_helpers-1.0.dist-info/WHEEL":    "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
		"demo_helpers-1.0.dist-info/METADATA": "Metadata-Version: 2.1\nName: demo-helpers\nVersion: 1.0\n",
	} {
		file, _ := writer.Create(name)
		file.Write([]byte(content))
	}
	writer.Close()
	manifestWithPackages := strings.Replace(pythonAppManifest, `"tools":`, `"python":{"packages":["demo-helpers==1.0"]},"tools":`, 1)
	request("PUT", "/admin/apps/calculator", map[string]any{
		"manifest":      json.RawMessage(manifestWithPackages),
		"functionFiles": []map[string]string{{"path": "functions/add.py", "content": "from demo_helpers import combine\ndef calculate(a,b=10): return combine(a,b)"}},
		"pythonWheels":  []pythonpackages.Wheel{{Name: "demo_helpers-1.0-py3-none-any.whl", Data: wheel.Bytes()}},
	})
	request("POST", "/admin/apps/calculator/install", nil)
	if res := call(map[string]any{"a": 3, "b": 4}); res.IsError || res.Content[0].(*mcp.TextContent).Text != `{"result":107}` {
		t.Fatalf("installed package import: %+v", res)
	}
	save("def calculate(a,b=10): return a+b") // removes the previous package bundle
	// A symlink in a hand-edited catalog cannot expose host source files.
	ra, _ := reg.App("calculator")
	outside := filepath.Join(t.TempDir(), "secret.py")
	os.WriteFile(outside, []byte("def calculate(a): return 'secret'"), 0600)
	entry := filepath.Join(ra.Dir, "functions", "add.py")
	os.Remove(entry)
	if err := os.Symlink(outside, entry); err != nil {
		t.Fatal(err)
	}
	if res := call(map[string]any{"a": 1}); !res.IsError {
		t.Fatal("symlink escaped app root")
	}
}
