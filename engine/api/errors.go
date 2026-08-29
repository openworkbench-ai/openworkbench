package api

import (
	"encoding/json"
	"net/http"
)

// apiError is the consistent error body shape for every failure.
type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details []any  `json:"details,omitempty"`
}

type errorEnvelope struct {
	Error apiError `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func writeError(w http.ResponseWriter, status int, code, message string, details ...any) {
	writeJSON(w, status, errorEnvelope{Error: apiError{
		Code:    code,
		Message: message,
		Details: details,
	}})
}
