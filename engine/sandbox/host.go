package sandbox

import (
	"context"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// hostModuleName is the WebAssembly import module name every guest function
// imports from. It is the only host surface a function ever sees.
const hostModuleName = "pocketknife"

// Sentinel return codes for the three capability-gated host calls
// (data_call, network_fetch, model_call). Any non-negative return is a
// success: its value is the number of bytes now sitting in the invocation's
// pending buffer, ready to be drained by result_read.
const (
	// codeDenied means the calling function never declared the capability
	// it just tried to use. pending is deliberately left empty: a denial
	// carries no information beyond the fact of denial, so a function cannot
	// use response content as an oracle to fingerprint entities, operations
	// or domains it was not granted.
	codeDenied int32 = -1
	// codeBadRequest means the request was malformed or rejected by a
	// business rule (e.g. a unique-constraint violation). pending holds a
	// JSON {"error": "..."} detail, since this is not security-sensitive.
	codeBadRequest int32 = -2
	// codeBackendError means the host's own implementation of a granted
	// capability failed unexpectedly (e.g. the model provider is
	// unreachable). pending holds a JSON {"error": "..."} detail.
	codeBackendError int32 = -3
)

// instantiateHostModule defines and instantiates the "pocketknife" host
// module once per Sandbox. Every function reads its own state only through
// invocationFrom(ctx); none of these closures hold any per-invocation state
// themselves, so the same host module instance is safe to call concurrently
// across invocations.
func instantiateHostModule(ctx context.Context, rt wazero.Runtime) error {
	_, err := rt.NewHostModuleBuilder(hostModuleName).
		NewFunctionBuilder().WithFunc(hostInputLen).Export("input_len").
		NewFunctionBuilder().WithFunc(hostInputRead).Export("input_read").
		NewFunctionBuilder().WithFunc(hostOutputWrite).Export("output_write").
		NewFunctionBuilder().WithFunc(hostDataCall).Export("data_call").
		NewFunctionBuilder().WithFunc(hostNetworkFetch).Export("network_fetch").
		NewFunctionBuilder().WithFunc(hostModelCall).Export("model_call").
		NewFunctionBuilder().WithFunc(hostResultRead).Export("result_read").
		Instantiate(ctx)
	return err
}

// hostInputLen reports the length of this invocation's input payload.
func hostInputLen(ctx context.Context, mod api.Module) uint32 {
	inv := invocationFrom(ctx)
	if inv == nil {
		return 0
	}
	return uint32(len(inv.input))
}

// hostInputRead copies up to maxLen bytes of the invocation's input into
// guest memory at ptr, starting from the beginning: a function is expected to
// call input_len first and read its whole input in one shot.
func hostInputRead(ctx context.Context, mod api.Module, ptr, maxLen uint32) uint32 {
	inv := invocationFrom(ctx)
	if inv == nil || len(inv.input) == 0 {
		return 0
	}
	n := uint32(len(inv.input))
	if n > maxLen {
		n = maxLen
	}
	if !mod.Memory().Write(ptr, inv.input[:n]) {
		return 0
	}
	return n
}

// hostOutputWrite reads n bytes from guest memory at ptr and appends them to
// the invocation's output buffer, capped at maxOutputBytes. It returns 0 on
// success, 1 if the memory range is invalid or the write would exceed the
// cap.
func hostOutputWrite(ctx context.Context, mod api.Module, ptr, n uint32) uint32 {
	inv := invocationFrom(ctx)
	if inv == nil {
		return 1
	}
	buf, ok := mod.Memory().Read(ptr, n)
	if !ok {
		return 1
	}
	if len(inv.output)+len(buf) > inv.maxOutputBytes {
		return 1
	}
	inv.output = append(inv.output, buf...)
	return 0
}

// hostResultRead copies up to maxLen bytes of the invocation's pending buffer
// (the result of the most recent gated call) into guest memory at ptr.
func hostResultRead(ctx context.Context, mod api.Module, ptr, maxLen uint32) uint32 {
	inv := invocationFrom(ctx)
	if inv == nil || len(inv.pending) == 0 {
		return 0
	}
	n := uint32(len(inv.pending))
	if n > maxLen {
		n = maxLen
	}
	if !mod.Memory().Write(ptr, inv.pending[:n]) {
		return 0
	}
	return n
}

func hostDataCall(ctx context.Context, mod api.Module, reqPtr, reqLen uint32) int32 {
	inv := invocationFrom(ctx)
	if inv == nil {
		return codeBackendError
	}
	reqBytes, ok := mod.Memory().Read(reqPtr, reqLen)
	if !ok {
		return codeBadRequest
	}
	body, code := handleDataCall(inv, reqBytes)
	return finishGated(inv, body, code)
}

func hostNetworkFetch(ctx context.Context, mod api.Module, reqPtr, reqLen uint32) int32 {
	inv := invocationFrom(ctx)
	if inv == nil {
		return codeBackendError
	}
	reqBytes, ok := mod.Memory().Read(reqPtr, reqLen)
	if !ok {
		return codeBadRequest
	}
	body, code := handleNetworkFetch(ctx, inv, reqBytes)
	return finishGated(inv, body, code)
}

func hostModelCall(ctx context.Context, mod api.Module, reqPtr, reqLen uint32) int32 {
	inv := invocationFrom(ctx)
	if inv == nil {
		return codeBackendError
	}
	reqBytes, ok := mod.Memory().Read(reqPtr, reqLen)
	if !ok {
		return codeBadRequest
	}
	body, code := handleModelCall(ctx, inv, reqBytes)
	return finishGated(inv, body, code)
}

// finishGated applies a gated handler's (body, code) result to the
// invocation's pending buffer and computes the value the guest actually
// sees: codeDenied always clears pending, any other negative code passes
// through with its error detail in pending, and a zero code (success) is
// translated to the byte length of body.
func finishGated(inv *invocation, body []byte, code int32) int32 {
	if code == codeDenied {
		inv.pending = nil
		return codeDenied
	}
	inv.pending = body
	if code != 0 {
		return code
	}
	return int32(len(body))
}
