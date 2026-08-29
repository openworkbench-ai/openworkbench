// Package sandbox is the real security boundary for a pocketknife app's
// server-side functions — not the manifest. A function's manifest entry only
// ever declares capabilities; this package is what actually enforces them.
// Every function body is treated as adversarial: it runs with no filesystem,
// no environment, no raw network, and no notion of any other invocation's
// state, behind a fixed, capability-checked host ABI that is the only way out
// of the WebAssembly module wazero runs it in.
//
// Status: implemented and tested in isolation; not yet invoked by any
// HTTP or MCP entry point in this binary. See docs/phase-4-wiring.md.
package sandbox

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

const (
	// DefaultMemoryLimitPages caps every function's linear memory at 256
	// pages (256 * 64KiB = 16MiB), regardless of what the module declares.
	DefaultMemoryLimitPages = 256
	// DefaultTimeout is the wall-clock budget given to a single invocation
	// before it is forcibly closed.
	DefaultTimeout = 5 * time.Second
	// DefaultMaxInputBytes caps the size of the input payload handed to a
	// function.
	DefaultMaxInputBytes = 1 << 20
	// DefaultMaxOutputBytes caps the total bytes a function may accumulate
	// via output_write across one invocation.
	DefaultMaxOutputBytes = 1 << 20
)

// Options configures resource limits enforced on every invocation. The zero
// value of every field means "use the package default" (see New).
type Options struct {
	MemoryLimitPages uint32
	Timeout          time.Duration
	MaxInputBytes    int
	MaxOutputBytes   int

	// Transport, if non-nil, replaces http.DefaultTransport for every
	// network_fetch call. Production code has no reason to set this — it
	// exists so tests can point a function's allow-listed, https-only fetch
	// at a local httptest server without weakening the host-decided scheme.
	Transport http.RoundTripper
}

func (o Options) withDefaults() Options {
	if o.MemoryLimitPages == 0 {
		o.MemoryLimitPages = DefaultMemoryLimitPages
	}
	if o.Timeout == 0 {
		o.Timeout = DefaultTimeout
	}
	if o.MaxInputBytes == 0 {
		o.MaxInputBytes = DefaultMaxInputBytes
	}
	if o.MaxOutputBytes == 0 {
		o.MaxOutputBytes = DefaultMaxOutputBytes
	}
	return o
}

// Sandbox compiles and runs functions' WebAssembly modules under a single
// shared wazero runtime. A Sandbox holds no per-function or per-invocation
// state itself: every Invoke call builds its own invocation-scoped state (see
// invocation), so concurrent invocations of the same or different functions
// never share mutable state.
type Sandbox struct {
	rt   wazero.Runtime
	opts Options

	mu       sync.Mutex
	compiled map[string]wazero.CompiledModule // keyed by absolute Entry path
}

// New builds a Sandbox: a wazero runtime configured to enforce opts'
// resource limits, with WASI preview1 and the capability-gated "pocketknife"
// host module instantiated once. The runtime grants no filesystem, no
// environment and no network to any guest module — wazero's WASI
// implementation is deny-by-default until a ModuleConfig opts in, and this
// Sandbox never opts in to any of it.
func New(opts Options) (*Sandbox, error) {
	opts = opts.withDefaults()
	ctx := context.Background()

	rConfig := wazero.NewRuntimeConfig().
		WithCloseOnContextDone(true).
		WithMemoryLimitPages(opts.MemoryLimitPages)
	rt := wazero.NewRuntimeWithConfig(ctx, rConfig)

	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		rt.Close(ctx)
		return nil, fmt.Errorf("sandbox: instantiate WASI: %w", err)
	}
	if err := instantiateHostModule(ctx, rt); err != nil {
		rt.Close(ctx)
		return nil, fmt.Errorf("sandbox: instantiate host module: %w", err)
	}

	return &Sandbox{
		rt:       rt,
		opts:     opts,
		compiled: map[string]wazero.CompiledModule{},
	}, nil
}

// Compile compiles the .wasm module at path (an absolute or working-directory
// relative file path resolved by the caller — Sandbox is agnostic about app
// layout) and caches the result, keyed by absolute path, so repeated Invoke
// calls for the same function never recompile it.
func (sb *Sandbox) Compile(ctx context.Context, path string) (wazero.CompiledModule, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("sandbox: resolve path %q: %w", path, err)
	}

	sb.mu.Lock()
	if cm, ok := sb.compiled[abs]; ok {
		sb.mu.Unlock()
		return cm, nil
	}
	sb.mu.Unlock()

	bin, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("sandbox: read %q: %w", abs, err)
	}
	cm, err := sb.rt.CompileModule(ctx, bin)
	if err != nil {
		return nil, fmt.Errorf("sandbox: compile %q: %w", abs, err)
	}

	sb.mu.Lock()
	defer sb.mu.Unlock()
	if existing, ok := sb.compiled[abs]; ok {
		// Another goroutine won the race; keep its result; the one this call
		// compiled is simply discarded (left for the runtime to close).
		return existing, nil
	}
	sb.compiled[abs] = cm
	return cm, nil
}

// Close releases the runtime and every module it compiled or instantiated.
func (sb *Sandbox) Close(ctx context.Context) error {
	return sb.rt.Close(ctx)
}
