package sandbox

import "errors"

// Sentinel errors classifyErr maps host/infra-level Invoke failures to. They
// are always wrapped together with the underlying error (Go 1.20+ multi-%w),
// so both remain reachable via errors.Is.
var (
	// ErrTimeout means the function ran past its allotted wall-clock budget
	// and was forcibly closed mid-execution.
	ErrTimeout = errors.New("sandbox: function timed out")
	// ErrResourceExhausted means the function hit a hard resource limit
	// (memory cap) and was forcibly closed mid-execution.
	ErrResourceExhausted = errors.New("sandbox: function exhausted its resource limits")
	// ErrTrapped means the function's WebAssembly module trapped for any
	// other reason (e.g. an out-of-bounds access, division by zero, or an
	// unreachable instruction not attributable to resource exhaustion).
	ErrTrapped = errors.New("sandbox: function trapped")
)
