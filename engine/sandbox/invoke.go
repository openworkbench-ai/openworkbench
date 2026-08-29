package sandbox

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"

	"pocketknife/broker"
	"pocketknife/schema"
	"pocketknife/store"
)

// Result is the outcome of a completed invocation: the guest ran to
// completion and returned control to the host, whether or not it considered
// itself successful.
type Result struct {
	// Output is whatever bytes the guest pushed via output_write.
	Output []byte
	// Failed is true if the guest's run() returned a nonzero code — a normal
	// completed invocation reporting a business-logic failure, not a
	// host-level error.
	Failed bool
}

// invocationContextKey is the unexported key invocationFrom and every host
// function look up. Using an unexported, zero-sized struct type as the key
// (rather than a string) means nothing outside this package can collide with
// or read it.
type invocationContextKey struct{}

// invocation is the per-call state threaded through context.Context into
// every host function closure. It is built fresh by Invoke and discarded at
// the end of the call: nothing in a Sandbox carries state across
// invocations, so two concurrent or sequential invocations — even of the same
// function — never share mutable state.
type invocation struct {
	fn     *schema.Function
	store  *store.Store
	app    *schema.App
	broker *broker.Broker

	input          []byte
	output         []byte
	maxOutputBytes int

	// pending holds the result of the most recently completed data_call,
	// network_fetch or model_call, ready to be drained by result_read. Guest
	// execution is sequential — wazero documents that a module's exported
	// function must not be called again until the previous call returns — so
	// exactly one gated call's result is ever pending at a time.
	pending []byte

	// client is built lazily and lives only for this invocation, used by
	// network_fetch. transport is threaded in from Sandbox.Options and is nil
	// in production, which makes client use http.DefaultTransport.
	client    *http.Client
	transport http.RoundTripper
}

func invocationFrom(ctx context.Context) *invocation {
	inv, _ := ctx.Value(invocationContextKey{}).(*invocation)
	return inv
}

func (inv *invocation) httpClient() *http.Client {
	if inv.client == nil {
		inv.client = &http.Client{
			Transport: inv.transport,
			// Every redirect hop must be independently capability-checked: if
			// the response we just allow-listed redirects to a different
			// host, following it automatically would let an allow-listed
			// origin act as a confused deputy into a host that was never
			// granted. Returning the un-followed response forces the guest
			// to issue a fresh network_fetch for the new Location, which gets
			// re-gated against the allow-list like any other request.
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return inv.client
}

// Invoke runs fn's compiled module once with input, under the Sandbox's
// configured resource limits. It returns a non-nil error only for host/infra
// level problems — timeout, resource exhaustion, a trap, or a failure to
// instantiate — never for a guest-reported business-logic failure, which
// surfaces as a normal Result with Failed set.
func (sb *Sandbox) Invoke(ctx context.Context, cm wazero.CompiledModule, fn *schema.Function, st *store.Store, app *schema.App, brk *broker.Broker, input []byte) (*Result, error) {
	if len(input) > sb.opts.MaxInputBytes {
		return nil, fmt.Errorf("sandbox: input of %d bytes exceeds the %d byte limit", len(input), sb.opts.MaxInputBytes)
	}

	inv := &invocation{
		fn:             fn,
		store:          st,
		app:            app,
		broker:         brk,
		input:          input,
		maxOutputBytes: sb.opts.MaxOutputBytes,
		transport:      sb.opts.Transport,
	}
	ctx = context.WithValue(ctx, invocationContextKey{}, inv)

	callCtx, cancel := context.WithTimeout(ctx, sb.opts.Timeout)
	defer cancel()

	// An anonymous name (WithName("")) lets the same CompiledModule be
	// instantiated repeatedly — once per invocation, never shared — and
	// WithStartFunctions() with no arguments suppresses the implicit call to
	// _start that a default ModuleConfig would otherwise make, since this is
	// a library-style module whose entry point is the exported "run", not a
	// WASI command's main.
	cfg := wazero.NewModuleConfig().WithName("").WithStartFunctions()
	mod, err := sb.rt.InstantiateModule(callCtx, cm, cfg)
	if err != nil {
		return nil, classifyErr(err)
	}
	defer mod.Close(context.Background())

	if initFn := mod.ExportedFunction("_initialize"); initFn != nil {
		if _, err := initFn.Call(callCtx); err != nil {
			return nil, classifyErr(err)
		}
	}

	runFn := mod.ExportedFunction("run")
	if runFn == nil {
		return nil, fmt.Errorf("sandbox: function %q's module exports no \"run\" function", fn.ID)
	}
	res, err := runFn.Call(callCtx)
	if err != nil {
		return nil, classifyErr(err)
	}

	code := api.DecodeI32(res[0])
	return &Result{Output: inv.output, Failed: code != 0}, nil
}

// classifyErr maps a host/infra-level error from a wazero call into one of
// this package's sentinel errors, while keeping the original error reachable
// via errors.Is (Go 1.20+ supports wrapping more than one error with %w).
func classifyErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return fmt.Errorf("%w: %w", ErrTimeout, err)
	}
	msg := err.Error()
	if strings.Contains(msg, "mallocgc") || strings.Contains(msg, "fatalthrow") || strings.Contains(msg, "out of memory") {
		return fmt.Errorf("%w: %w", ErrResourceExhausted, err)
	}
	return fmt.Errorf("%w: %w", ErrTrapped, err)
}
