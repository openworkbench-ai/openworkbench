package functions_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"pocketknife/functions"
	"pocketknife/registry"
	"pocketknife/schema"
)

// The original host-ABI guest still runs through the new manifest dispatcher,
// without installing CPython or providing a model broker.
func TestPrecompiledWasmFunction(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("go", "build", "-buildmode=c-shared", "-o", filepath.Join(dir, "driver.wasm"), "./driver")
	cmd.Dir = "../sandbox/testdata/guestsrc"
	cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build guest: %v\n%s", err, out)
	}
	executor, err := functions.New("unused", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { executor.Close(context.Background()) })
	fn := &schema.Function{ID: "fn_echo", Name: "echo", Entry: "driver.wasm", Runtime: "wasm"}
	app := &registry.RegisteredApp{Dir: dir, Schema: &schema.App{ID: "test"}}
	res, err := executor.Invoke(context.Background(), app, fn, []byte(`{"action":"echo","request":{"answer":42}}`))
	if err != nil || res.Failed || string(res.Output) != `{"answer":42}` {
		t.Fatalf("echo: %v %v", res, err)
	}
	// No broker is configured: the capability-gated call is a backend error,
	// not a nil-pointer panic and not a leaked provider token.
	fn.Capabilities = &schema.Capabilities{Model: true}
	res, err = executor.Invoke(context.Background(), app, fn, []byte(`{"action":"model","request":{"prompt":"hello"}}`))
	if err != nil || res.Failed {
		t.Fatalf("model fallback: %v %v", res, err)
	}
}
