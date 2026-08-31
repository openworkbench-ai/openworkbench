// Package adminapi exposes the app lifecycle as HTTP: install (validate,
// materialize, seed, and register a catalog app that either doesn't exist in
// the registry yet or is being reinstalled after a manifest edit), plus
// activate/deactivate to toggle whether an already-loaded app is served,
// and a list endpoint to see every app's current status. This is what lets
// a caller -- initially a human, eventually the builder agent -- add or
// toggle one app without restarting the process: every other route in this
// binary (api, mcpserver) reads the same *registry.Registry these handlers
// mutate, and already re-resolves it per request, so a change made here is
// visible to the very next request anywhere else in the server.
//
// {id} is never trusted as-is: it becomes part of a filesystem path
// (catalogDir/{id}/manifest.json) inside lifecycle.Install, so every handler
// rejects an id that doesn't match the manifest schema's own stableId
// pattern before doing anything else -- the same guard a manifest's app.id
// would have to pass anyway, just enforced earlier, against attacker input,
// rather than left to fail deep inside a file read.
package adminapi

import (
	"encoding/json"
	"net/http"

	"pocketknife/lifecycle"
	"pocketknife/registry"
)

// Server wraps the registry and catalog/data directories every install
// resolves an app's manifest and database against.
type Server struct {
	reg        *registry.Registry
	catalogDir string
	dataDir    string
}

// NewServer builds the admin HTTP handler over the given registry and the
// same catalog/data directories the process booted with.
func NewServer(reg *registry.Registry, catalogDir, dataDir string) http.Handler {
	s := &Server{reg: reg, catalogDir: catalogDir, dataDir: dataDir}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /admin/apps", s.handleList)
	mux.HandleFunc("POST /admin/apps/{id}/install", s.handleInstall)
	mux.HandleFunc("POST /admin/apps/{id}/activate", s.handleActivate)
	mux.HandleFunc("POST /admin/apps/{id}/deactivate", s.handleDeactivate)
	return mux
}

type appStatus struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	ids := s.reg.IDs()
	out := make([]appStatus, 0, len(ids))
	for _, id := range ids {
		status, _ := s.reg.Status(id)
		out = append(out, appStatus{ID: id, Status: status})
	}
	writeJSON(w, http.StatusOK, map[string]any{"apps": out})
}

func (s *Server) handleInstall(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !lifecycle.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid_id", "app id must match ^[a-z][a-z0-9_]*$")
		return
	}

	res := lifecycle.Install(s.reg, s.catalogDir, s.dataDir, id)
	if !res.OK {
		writeLoadFailure(w, res)
		return
	}
	writeJSON(w, http.StatusOK, appStatus{ID: id, Status: "active"})
}

func (s *Server) handleActivate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !lifecycle.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid_id", "app id must match ^[a-z][a-z0-9_]*$")
		return
	}

	if !s.reg.Activate(id) {
		writeToggleFailure(w, s.reg, id, "activate")
		return
	}
	writeJSON(w, http.StatusOK, appStatus{ID: id, Status: "active"})
}

func (s *Server) handleDeactivate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !lifecycle.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid_id", "app id must match ^[a-z][a-z0-9_]*$")
		return
	}

	if !s.reg.Deactivate(id) {
		writeToggleFailure(w, s.reg, id, "deactivate")
		return
	}
	writeJSON(w, http.StatusOK, appStatus{ID: id, Status: "inactive"})
}

// writeToggleFailure distinguishes "already in the requested state" (409 --
// the caller's request is well-formed but redundant) from "never
// registered at all" (404), since Activate/Deactivate returning false could
// mean either.
func writeToggleFailure(w http.ResponseWriter, reg *registry.Registry, id, verb string) {
	status, ok := reg.Status(id)
	if !ok {
		writeError(w, http.StatusNotFound, "app_not_found", "app \""+id+"\" is not registered; install it first")
		return
	}
	writeError(w, http.StatusConflict, "already_"+status, "app \""+id+"\" is already "+status)
	_ = verb
}

// writeLoadFailure maps a failed registry.LoadResult onto this API's wire
// contract -- the same distinction validateapi draws between a malformed
// manifest (422, with structured errors to fix) and any other failure
// (500: a filesystem, materialize, or seed problem, none of which the
// caller can fix by editing the manifest's JSON shape alone).
func writeLoadFailure(w http.ResponseWriter, res registry.LoadResult) {
	if len(res.Errors) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"valid": false, "errors": res.Errors})
		return
	}
	message := "install failed"
	if res.Err != nil {
		message = res.Err.Error()
	}
	writeError(w, http.StatusInternalServerError, "install_failed", message)
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorEnvelope struct {
	Error apiError `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorEnvelope{Error: apiError{Code: code, Message: message}})
}
