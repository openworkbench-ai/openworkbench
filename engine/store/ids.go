package store

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// TimeFormat is the single canonical encoding for every datetime the runtime
// emits or stores: ISO-8601 in UTC with millisecond precision and a literal Z.
// The runtime never deviates from this encoding.
const TimeFormat = "2006-01-02T15:04:05.000Z07:00"

// NewID returns a server-generated, unique, opaque row identifier. It is a
// random 128-bit value, hex-encoded; it carries no meaning and is never derived
// from row contents.
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failure is catastrophic and not something the caller can
		// sensibly handle mid-request.
		panic(fmt.Sprintf("cannot generate id: %v", err))
	}
	return hex.EncodeToString(b[:])
}

// NowUTC returns the current instant in the canonical encoding.
func NowUTC() string {
	return time.Now().UTC().Format(TimeFormat)
}

// CanonicalDatetime parses a user-supplied ISO-8601 datetime and re-emits it in
// the canonical UTC encoding, so storage never holds two spellings of the same
// instant. It accepts any RFC3339 input (with offset or Z).
func CanonicalDatetime(s string) (string, error) {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return "", fmt.Errorf("not a valid ISO-8601 datetime: %s", s)
	}
	return t.UTC().Format(TimeFormat), nil
}
