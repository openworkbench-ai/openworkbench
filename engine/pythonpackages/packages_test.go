package pythonpackages_test

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pocketknife/pythonpackages"
)

func wheel(t *testing.T, name string, files map[string]string) pythonpackages.Wheel {
	t.Helper()
	var data bytes.Buffer
	w := zip.NewWriter(&data)
	for path, content := range files {
		f, err := w.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(content))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return pythonpackages.Wheel{Name: name, Data: data.Bytes()}
}

func TestInstallPortablePackages(t *testing.T) {
	files := map[string]string{
		"demo-1.0.dist-info/WHEEL":           "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
		"demo/__init__.py":                   "def answer(): return 42\n",
		"demo/data/example.txt":              "package resource",
		"demo-1.0.data/purelib/relocated.py": "VALUE = 1",
	}
	w := wheel(t, "demo-1.0-py3-none-any.whl", files)
	dir := t.TempDir()
	if err := pythonpackages.Install(dir, []pythonpackages.Wheel{w}, []string{"demo>=1"}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"demo/__init__.py", "demo/data/example.txt", "relocated.py"} {
		if _, err := os.Stat(filepath.Join(dir, "python", "site-packages", path)); err != nil {
			t.Fatal(err)
		}
	}
	lock, err := os.ReadFile(filepath.Join(dir, "python", "wheels.lock.json"))
	if err != nil || !strings.Contains(string(lock), "sha256") {
		t.Fatalf("lock: %s %v", lock, err)
	}
	for _, tt := range []struct {
		name   string
		wheels []pythonpackages.Wheel
		req    []string
	}{
		{"missing dependency", []pythonpackages.Wheel{w}, []string{"other==1"}},
		{"undeclared packages", []pythonpackages.Wheel{w}, nil},
		{"duplicate distribution", []pythonpackages.Wheel{w, w}, []string{"demo"}},
		{"native wheel", []pythonpackages.Wheel{{Name: "demo-1.0-cp313-cp313-macosx_11_0_arm64.whl", Data: w.Data}}, []string{"demo"}},
		{"invalid zip", []pythonpackages.Wheel{{Name: w.Name, Data: []byte("not zip")}}, []string{"demo"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if err := pythonpackages.Validate(tt.wheels, tt.req); err == nil {
				t.Fatal("invalid package accepted")
			}
		})
	}
	for _, path := range []string{"../escape.py", "/absolute.py", `demo\escape.py`, "demo/native.so"} {
		bad := wheel(t, w.Name, map[string]string{path: "bad", "demo-1.0.dist-info/WHEEL": files["demo-1.0.dist-info/WHEEL"]})
		if err := pythonpackages.Validate([]pythonpackages.Wheel{bad}, []string{"demo"}); err == nil {
			t.Fatalf("invalid path accepted: %s", path)
		}
	}
}
