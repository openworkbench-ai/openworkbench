// Package cors is a small, optional middleware for local development: serving
// a frontend from a separate dev server (different origin/port) than the API
// needs cross-origin requests allowed. The production binary serves the API
// and the built frontend from one origin and never needs this — the trusted
// core stays headless and CORS-free unless explicitly enabled.
package cors

import "net/http"

// Middleware wraps next with permissive CORS headers when enabled is true;
// when false it returns next unchanged.
func Middleware(enabled bool, next http.Handler) http.Handler {
	if !enabled {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
