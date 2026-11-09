package sandbox

import (
	"bytes"
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
	"github.com/tetratelabs/wazero/sys"
	"pocketknife/schema"
)

// Python is a WASI CPython interpreter compiled once, instantiated separately
// for every call. The standard library and app packages are mounted read-only.
// Source and arguments arrive on stdin; no app directory, host environment,
// writable filesystem, sockets, or subprocess capability is provided. HTTPS
// requests use a framed host bridge that rechecks the manifest's network grants.
type Python struct {
	rt       wazero.Runtime
	compiled wazero.CompiledModule
	libDir   string
	opts     Options
}

// NewPython loads a WASI preview1 CPython distribution containing python.wasm
// and lib/. scripts/setup-python-wasm.sh installs the pinned distribution.
// Python needs a larger memory budget than the small compiled-function guests.
func NewPython(ctx context.Context, dir string, opts Options) (*Python, error) {
	if opts.MemoryLimitPages == 0 {
		opts.MemoryLimitPages = 2048 // 128 MiB, per invocation
	}
	opts = opts.withDefaults()
	bin, err := os.ReadFile(filepath.Join(dir, "python.wasm"))
	if err != nil {
		return nil, fmt.Errorf("Python Wasm runtime unavailable: run scripts/setup-python-wasm.sh or set POCKETKNIFE_PYTHON_DIR: %w", err)
	}
	libDir, err := filepath.Abs(filepath.Join(dir, "lib"))
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(libDir); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("Python Wasm standard library missing in %s", libDir)
	}
	rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().
		WithCloseOnContextDone(true).WithMemoryLimitPages(opts.MemoryLimitPages))
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		rt.Close(ctx)
		return nil, err
	}
	cm, err := rt.CompileModule(ctx, bin)
	if err != nil {
		rt.Close(ctx)
		return nil, fmt.Errorf("compile Python Wasm: %w", err)
	}
	return &Python{rt: rt, compiled: cm, libDir: libDir, opts: opts}, nil
}

func (p *Python) Close(ctx context.Context) error { return p.rt.Close(ctx) }

// PythonInvocation supplies host-owned grants and an app-confined, read-only
// package filesystem. These are never accepted from the guest protocol.
type PythonInvocation struct {
	Function *schema.Function
	Packages fs.FS
}

// Invoke calls handler(**args) from source. Prints are diagnostics, never mixed
// with the result. Exceptions and non-JSON return values become guest failures.
func (p *Python) Invoke(ctx context.Context, source []byte, handler string, args json.RawMessage, configs ...PythonInvocation) (*Result, error) {
	var config PythonInvocation
	if len(configs) > 0 {
		config = configs[0]
	}
	fn := config.Function
	if fn == nil {
		fn = &schema.Function{Capabilities: &schema.Capabilities{}}
	}
	if len(source)+len(args) > p.opts.MaxInputBytes {
		return nil, fmt.Errorf("Python source and arguments exceed the %d byte input limit", p.opts.MaxInputBytes)
	}
	if handler == "" {
		handler = "main"
	}
	input, err := json.Marshal(struct {
		Source  string          `json:"source"`
		Handler string          `json:"handler"`
		Args    json.RawMessage `json:"args"`
		Network bool            `json:"network"`
	}{string(source), handler, args, fn.Capabilities != nil && len(fn.Capabilities.Network) > 0})
	if err != nil {
		return nil, err
	}
	diagnostics := &limitedOutput{limit: 16 << 10, discardOverflow: true}
	callCtx, cancel := context.WithTimeout(ctx, invocationTimeout(p.opts.Timeout, fn))
	defer cancel()
	channelInput := bytes.NewBuffer(append(input, '\n'))
	bridge := &pythonBridge{ctx: callCtx, inv: &invocation{fn: fn, transport: p.opts.Transport}, input: channelInput, maxOutput: p.opts.MaxOutputBytes}
	fsConfig := wazero.NewFSConfig().WithReadOnlyDirMount(p.libDir, "/python/lib")
	if config.Packages != nil {
		fsConfig = fsConfig.WithFSMount(config.Packages, "/packages")
	}
	cfg := wazero.NewModuleConfig().WithName("").
		WithArgs("python", "-B", "-S", "-P", "-c", pythonBootstrap).
		WithEnv("PYTHONHOME", "/python").WithEnv("PYTHONHASHSEED", "0").
		WithEnv("PYTHONPATH", "/packages").
		WithStdin(channelInput).WithStdout(bridge).WithStderr(diagnostics).
		WithRandSource(rand.Reader).WithSysWalltime().WithSysNanotime().
		WithNanosleep(func(ns int64) {
			timer := time.NewTimer(time.Duration(ns))
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-callCtx.Done():
			}
		}).
		WithFSConfig(fsConfig)
	mod, err := p.rt.InstantiateModule(callCtx, p.compiled, cfg)
	if mod != nil {
		defer mod.Close(context.Background())
	}
	if bridge.err != nil {
		return nil, bridge.err
	}
	if err != nil {
		var exit *sys.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 0 {
			return nil, classifyErr(err)
		}
	}
	var envelope struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(bridge.output, &envelope); err != nil {
		return nil, fmt.Errorf("Python function returned an invalid result (expected JSON)")
	}
	if !envelope.OK {
		payload, _ := json.Marshal(map[string]string{"error": envelope.Error})
		return &Result{Output: payload, Failed: true}, nil
	}
	if len(envelope.Result) == 0 {
		return nil, fmt.Errorf("Python function returned no result")
	}
	return &Result{Output: envelope.Result}, nil
}

// Bounded on the host as well as in guest linear memory. A guest can ignore a
// failed fd_write; overflow stays sticky so truncated output cannot succeed.
type limitedOutput struct {
	bytes.Buffer
	limit           int
	overflow        bool
	discardOverflow bool
}

func (w *limitedOutput) Write(b []byte) (int, error) {
	n := len(b)
	remaining := w.limit - w.Len()
	if n <= remaining {
		return w.Buffer.Write(b)
	}
	w.overflow = true
	w.Buffer.Write(b[:remaining])
	if w.discardOverflow {
		return n, nil
	}
	return remaining, io.ErrShortWrite
}

//go:embed python_bootstrap.py
var pythonBootstrap string
