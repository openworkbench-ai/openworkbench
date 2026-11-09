package validate_test

import (
	"encoding/json"
	"strings"
	"testing"
)

const pythonManifest = `{
 "app":{"id":"calculator","name":"Calculator","version":1},
 "entities":[{"id":"ent_note","name":"note","fields":[{"id":"f_text","name":"text","type":"text"}]}],
 "functions":[{"id":"fn_add","name":"add","runtime":"python","entry":"functions/add.py","capabilities":{}}],
 "tools":[{"id":"tool_add","name":"add","function":"fn_add","params":[{"id":"p_a","name":"a","type":"integer","required":true}]}]
}`

func TestPythonFunctionManifest(t *testing.T) {
	app := mustValid(t, pythonManifest)
	fn := app.FunctionByID("fn_add")
	if fn.Runtime != "python" || fn.Handler != "main" || app.Tool("add").Function != "fn_add" {
		t.Fatalf("parsed function: %+v", fn)
	}
	for _, tt := range []struct{ name, from, to string }{
		{"unknown function", `"function":"fn_add"`, `"function":"fn_missing"`},
		{"two implementations", `"function":"fn_add"`, `"function":"fn_add","steps":[{"op":"list","entity":"ent_note"}]`},
		{"no implementation", `"function":"fn_add",`, ``},
		{"traversal", `functions/add.py`, `functions/../../secret.py`},
		{"absolute path", `functions/add.py`, `/tmp/add.py`},
		{"backslash", `functions/add.py`, `functions\\add.py`},
		{"wrong extension", `functions/add.py`, `functions/add.wasm`},
		{"wrong directory", `functions/add.py`, `add.py`},
		{"data grant", `"capabilities":{}`, `"capabilities":{"data":[{"entity":"ent_note","operations":["read"]}]}`},
		{"model grant", `"capabilities":{}`, `"capabilities":{"model":true}`},
		{"unknown runtime", `"runtime":"python"`, `"runtime":"native"`},
		{"invalid handler", `"runtime":"python"`, `"runtime":"python","handler":"main()"`},
		{"excessive timeout", `"runtime":"python"`, `"runtime":"python","timeoutSeconds":121`},
	} {
		t.Run(tt.name, func(t *testing.T) { mustInvalid(t, strings.Replace(pythonManifest, tt.from, tt.to, 1)) })
	}
	withNetwork := strings.Replace(pythonManifest, `"capabilities":{}`, `"timeoutSeconds":60,"capabilities":{"network":["www.kleinanzeigen.de"]}`, 1)
	app = mustValid(t, withNetwork)
	if app.Functions[0].TimeoutSeconds != 60 || !app.Functions[0].Capabilities.AllowsDomain("www.kleinanzeigen.de") {
		t.Fatal("Python network grant or timeout missing")
	}
	withPackages := strings.Replace(pythonManifest, `"tools":`, `"python":{"packages":["tzdata==2026.6","packaging>=25"]},"tools":`, 1)
	if got := mustValid(t, withPackages).Python.Packages; len(got) != 2 {
		t.Fatal("package dependencies missing")
	}
	// Old function declarations remain Wasm by default.
	var raw map[string]any
	json.Unmarshal([]byte(pythonManifest), &raw)
	fnRaw := raw["functions"].([]any)[0].(map[string]any)
	delete(fnRaw, "runtime")
	fnRaw["entry"] = "functions/add.wasm"
	b, _ := json.Marshal(raw)
	if got := mustValid(t, string(b)).Functions[0].Runtime; got != "wasm" {
		t.Fatalf("default runtime=%s", got)
	}
}
