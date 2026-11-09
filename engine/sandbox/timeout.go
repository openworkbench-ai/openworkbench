package sandbox

import (
	"pocketknife/schema"
	"time"
)

func invocationTimeout(fallback time.Duration, fn *schema.Function) time.Duration {
	if fn == nil || fn.TimeoutSeconds <= 0 {
		return fallback
	}
	seconds := min(fn.TimeoutSeconds, 120)
	return time.Duration(seconds) * time.Second
}
