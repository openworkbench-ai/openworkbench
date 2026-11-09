package sandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// Python has no sockets. A synchronous, newline-framed stdio protocol lets
// guest helpers ask the same capability-checked host network_fetch used by
// precompiled Wasm. Each invocation owns both sides of the channel. The guest
// may forge frames; authority comes exclusively from inv.fn on the host.
type pythonBridge struct {
	ctx       context.Context
	inv       *invocation
	input     *bytes.Buffer
	line      []byte
	output    []byte
	maxOutput int
	err       error
}

func (b *pythonBridge) Write(data []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	total := len(data)
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		end := len(data)
		if i >= 0 {
			end = i
		}
		if len(b.line)+end > max(b.maxOutput, DefaultMaxInputBytes)+1024 {
			b.err = ErrResourceExhausted
			return 0, b.err
		}
		b.line = append(b.line, data[:end]...)
		if i < 0 {
			break
		}
		if err := b.frame(b.line); err != nil {
			b.err = err
			return 0, err
		}
		b.line = nil
		data = data[i+1:]
	}
	return total, nil
}

func (b *pythonBridge) frame(line []byte) error {
	var frame struct {
		Type    string          `json:"type"`
		Request json.RawMessage `json:"request"`
		Seconds float64         `json:"seconds"`
	}
	if err := json.Unmarshal(line, &frame); err != nil {
		return fmt.Errorf("invalid Python host message")
	}
	switch frame.Type {
	case "sleep":
		if frame.Seconds < 0 {
			return fmt.Errorf("invalid Python sleep duration")
		}
		timer := time.NewTimer(time.Duration(min(frame.Seconds, 1e9) * float64(time.Second)))
		defer timer.Stop()
		select {
		case <-timer.C:
			if b.input.Len()+11 > 8<<20 {
				return ErrResourceExhausted
			}
			b.input.WriteString("{\"code\":0}\n")
		case <-b.ctx.Done():
			return fmt.Errorf("%w: %w", ErrTimeout, b.ctx.Err())
		}
	case "network":
		if len(line) > DefaultMaxInputBytes {
			return ErrResourceExhausted
		}
		body, code := handleNetworkFetch(b.ctx, b.inv, frame.Request)
		response, err := json.Marshal(struct {
			Code     int32           `json:"code"`
			Response json.RawMessage `json:"response,omitempty"`
		}{code, body})
		if err != nil {
			return err
		}
		if b.input.Len()+len(response)+1 > 8<<20 {
			return ErrResourceExhausted
		}
		// Denials carry only a code, never an upstream response.
		b.input.Write(response)
		b.input.WriteByte('\n')
	case "result":
		if len(line) > b.maxOutput {
			return ErrResourceExhausted
		}
		if b.output != nil {
			return fmt.Errorf("duplicate Python result")
		}
		b.output = append([]byte(nil), line...)
	default:
		return fmt.Errorf("unknown Python host operation")
	}
	return nil
}
