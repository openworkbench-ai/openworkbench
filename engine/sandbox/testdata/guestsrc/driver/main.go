// driver is the one fixture guest function the sandbox package's tests
// exercise. It is not a stand-in for an LLM-authored function — it is
// parameterized entirely by its input payload so every adversarial and
// positive test case in sandbox_test.go can reuse the same compiled module,
// varying only the bytes sent in. The action names below ("data", "network",
// "model", "fs", "env", "net_dial", "loop", "alloc", "echo") each probe one
// thing the sandbox is responsible for either gating or denying outright.
package main

import (
	"encoding/json"
	"net"
	"os"
	"unsafe"
)

//go:wasmimport pocketknife input_len
func inputLen() uint32

//go:wasmimport pocketknife input_read
func inputRead(ptr unsafe.Pointer, maxLen uint32) uint32

//go:wasmimport pocketknife output_write
func outputWrite(ptr unsafe.Pointer, n uint32) uint32

//go:wasmimport pocketknife data_call
func dataCall(reqPtr unsafe.Pointer, reqLen uint32) int32

//go:wasmimport pocketknife network_fetch
func networkFetch(reqPtr unsafe.Pointer, reqLen uint32) int32

//go:wasmimport pocketknife model_call
func modelCall(reqPtr unsafe.Pointer, reqLen uint32) int32

//go:wasmimport pocketknife result_read
func resultRead(ptr unsafe.Pointer, maxLen uint32) uint32

// maxResultBytes is how much of a denial/error detail this driver will ever
// try to pull back via result_read. It only matters for the bad_request and
// backend_error codes, since a denial leaves nothing to read.
const maxResultBytes = 1 << 20

// instruction is the input payload's shape: which action to run, and (for
// the three gated actions) the raw request body to forward verbatim.
type instruction struct {
	Action  string          `json:"action"`
	Request json.RawMessage `json:"request"`
}

// gatedResult is what this driver writes to output after a gated call, so
// the host-side test can inspect both the sentinel code and any detail body
// without needing a second round trip.
type gatedResult struct {
	Code int32  `json:"code"`
	Body string `json:"body"`
}

func readInput() []byte {
	n := inputLen()
	if n == 0 {
		return nil
	}
	buf := make([]byte, n)
	got := inputRead(unsafe.Pointer(&buf[0]), n)
	return buf[:got]
}

func writeOutput(b []byte) {
	if len(b) == 0 {
		return
	}
	outputWrite(unsafe.Pointer(&b[0]), uint32(len(b)))
}

func readResult(maxLen uint32) []byte {
	if maxLen == 0 {
		return nil
	}
	buf := make([]byte, maxLen)
	n := resultRead(unsafe.Pointer(&buf[0]), maxLen)
	return buf[:n]
}

func ptrOf(b []byte) unsafe.Pointer {
	if len(b) == 0 {
		return nil
	}
	return unsafe.Pointer(&b[0])
}

// reportGated drains whatever the host left in the pending buffer for a
// gated call's return code and writes it to output as a gatedResult, so the
// test asserting on this invocation's Result.Output can see exactly what the
// guest saw: the code, and (for non-denied outcomes) the detail body.
func reportGated(code int32) {
	var body []byte
	if code >= 0 {
		body = readResult(uint32(code))
	} else if code != -1 {
		body = readResult(maxResultBytes)
	}
	out, _ := json.Marshal(gatedResult{Code: code, Body: string(body)})
	writeOutput(out)
}

//go:wasmexport run
func Run() int32 {
	raw := readInput()
	var instr instruction
	if err := json.Unmarshal(raw, &instr); err != nil {
		writeOutput([]byte(`{"error":"bad instruction"}`))
		return 1
	}

	switch instr.Action {
	case "echo":
		writeOutput(instr.Request)
		return 0

	case "data":
		reportGated(dataCall(ptrOf(instr.Request), uint32(len(instr.Request))))
		return 0

	case "network":
		reportGated(networkFetch(ptrOf(instr.Request), uint32(len(instr.Request))))
		return 0

	case "model":
		reportGated(modelCall(ptrOf(instr.Request), uint32(len(instr.Request))))
		return 0

	case "fs":
		// Attempts to read a real host file. The sandbox grants no
		// filesystem at all, so this must fail every time, never succeed.
		if _, err := os.ReadFile("/etc/passwd"); err != nil {
			writeOutput([]byte(err.Error()))
			return 1
		}
		return 0

	case "env":
		// The sandbox grants no environment, so this must always come back
		// empty.
		v := os.Getenv("HOME")
		writeOutput([]byte(v))
		if v != "" {
			return 1
		}
		return 0

	case "net_dial":
		// A raw socket dial, entirely outside network_fetch's capability
		// gate. Must always fail: there is no general fetch.
		conn, err := net.Dial("tcp", "example.com:80")
		if err != nil {
			writeOutput([]byte(err.Error()))
			return 1
		}
		conn.Close()
		return 0

	case "loop":
		var x int32
		for {
			x++
		}

	case "alloc":
		var sink [][]byte
		for {
			b := make([]byte, 1<<20)
			for i := range b {
				b[i] = 1
			}
			sink = append(sink, b)
		}
	}

	writeOutput([]byte(`{"error":"unknown action"}`))
	return 1
}

func main() {}
