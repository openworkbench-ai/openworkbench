// Package functions dispatches manifest functions to the engine's Wasm runtimes.
package functions

import (
	"context"
	"fmt"
	"io"
	"os"
	"sync"

	"pocketknife/broker"
	"pocketknife/registry"
	"pocketknife/sandbox"
	"pocketknife/schema"
)

// Executor owns shared runtimes; every invocation still has fresh guest state.
type Executor struct {
	sandbox    *sandbox.Sandbox
	broker     *broker.Broker
	pythonDir  string
	pythonOnce sync.Once
	python     *sandbox.Python
	pythonErr  error
}

func New(pythonDir string, brk *broker.Broker) (*Executor, error) {
	if brk == nil {
		brk = broker.New(nil)
	}
	sb, err := sandbox.New(sandbox.Options{})
	if err != nil {
		return nil, err
	}
	return &Executor{sandbox: sb, broker: brk, pythonDir: pythonDir}, nil
}

func (e *Executor) Close(ctx context.Context) error {
	if e.python != nil {
		e.python.Close(ctx)
	}
	return e.sandbox.Close(ctx)
}

func (e *Executor) Invoke(ctx context.Context, ra *registry.RegisteredApp, fn *schema.Function, input []byte) (*sandbox.Result, error) {
	// OpenRoot prevents both traversal and symlinks from escaping the app.
	root, err := os.OpenRoot(ra.Dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	f, err := root.Open(fn.Entry)
	if err != nil {
		return nil, fmt.Errorf("open function %q: %w", fn.Name, err)
	}
	defer f.Close()
	if fn.Runtime == "python" {
		c := fn.Capabilities
		if c != nil && (len(c.Data) > 0 || c.Model) {
			return nil, fmt.Errorf("Python data and model bridges are not implemented")
		}
		source, err := io.ReadAll(io.LimitReader(f, sandbox.DefaultMaxInputBytes+1))
		if err != nil {
			return nil, err
		}
		if len(source) > sandbox.DefaultMaxInputBytes {
			return nil, fmt.Errorf("Python source exceeds input limit")
		}
		e.pythonOnce.Do(func() {
			// Runtime initialization is shared, not owned by the first caller's
			// cancellation. Invocation deadlines apply separately inside Invoke.
			e.python, e.pythonErr = sandbox.NewPython(context.Background(), e.pythonDir, sandbox.Options{})
		})
		if e.pythonErr != nil {
			return nil, e.pythonErr
		}
		config := sandbox.PythonInvocation{Function: fn}
		if ra.Schema.Python != nil && len(ra.Schema.Python.Packages) > 0 {
			packages, err := root.OpenRoot("python/site-packages")
			if err != nil {
				return nil, fmt.Errorf("Python packages are missing; reinstall the app: %w", err)
			}
			defer packages.Close()
			config.Packages = packages.FS()
		}
		return e.python.Invoke(ctx, source, fn.Handler, input, config)
	}
	// Read through the confined handle, then compile by content so replacing a
	// function at the same catalog path cannot reuse stale compiled code.
	bin, err := io.ReadAll(io.LimitReader(f, 64<<20+1))
	if err != nil {
		return nil, err
	}
	if len(bin) > 64<<20 {
		return nil, fmt.Errorf("Wasm function exceeds module size limit")
	}
	cm, err := e.sandbox.CompileBytes(ctx, bin)
	if err != nil {
		return nil, err
	}
	return e.sandbox.Invoke(ctx, cm, fn, ra.Store, ra.Schema, e.broker, input)
}
