// Package api is the one generic, schema-driven HTTP surface that serves every
// app. It is a thin transport adapter: every handler parses the HTTP-specific
// parts of the request (path values, query string, request body bytes),
// calls the matching pocketknife/domain operation, and maps the result back
// onto the wire — the field-validation rules, the app/entity/operation
// resolution, and the store calls all live in domain, not here, so a future
// non-HTTP caller (an MCP tool, or any other internal Workbench caller) can
// call the same operations directly. Routes are namespaced by app:
// /apps/{app_id}/{entity_name}.
package api

import (
	"encoding/json"
	"io"
	"net/http"

	"pocketknife/domain"
	"pocketknife/registry"
)

// Server wraps the registry and exposes an http.Handler.
type Server struct {
	reg *registry.Registry
}

// NewServer builds the generic HTTP handler over the given registry.
func NewServer(reg *registry.Registry) http.Handler {
	s := &Server{reg: reg}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /apps/{app}/{entity}", s.handleCreate)
	mux.HandleFunc("GET /apps/{app}/{entity}", s.handleList)
	mux.HandleFunc("GET /apps/{app}/{entity}/{id}", s.handleRead)
	mux.HandleFunc("PATCH /apps/{app}/{entity}/{id}", s.handleUpdate)
	mux.HandleFunc("DELETE /apps/{app}/{entity}/{id}", s.handleDelete)
	return mux
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	appID, entName := r.PathValue("app"), r.PathValue("entity")
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	if issues := s.unknownFieldIssues(appID, entName, body); len(issues) > 0 {
		writeValidationError(w, issues)
		return
	}

	row, operr := domain.Create(s.reg, appID, entName, body)
	if operr != nil {
		writeOpError(w, operr)
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) {
	row, operr := domain.Get(s.reg, r.PathValue("app"), r.PathValue("entity"), r.PathValue("id"))
	if operr != nil {
		writeOpError(w, operr)
		return
	}
	writeJSON(w, http.StatusOK, row)
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	res, operr := domain.List(s.reg, r.PathValue("app"), r.PathValue("entity"), r.URL.Query())
	if operr != nil {
		writeOpError(w, operr)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data":   res.Rows,
		"total":  res.Total,
		"limit":  res.Limit,
		"offset": res.Offset,
	})
}

func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	appID, entName := r.PathValue("app"), r.PathValue("entity")
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	if issues := s.unknownFieldIssues(appID, entName, body); len(issues) > 0 {
		writeValidationError(w, issues)
		return
	}

	row, operr := domain.Update(s.reg, appID, entName, r.PathValue("id"), body)
	if operr != nil {
		writeOpError(w, operr)
		return
	}
	writeJSON(w, http.StatusOK, row)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	_, operr := domain.Delete(s.reg, r.PathValue("app"), r.PathValue("entity"), r.PathValue("id"))
	if operr != nil {
		writeOpError(w, operr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// unknownFieldIssues reports any body key that isn't one of the entity's
// declared fields. This is an HTTP-body strictness policy, not a coercion
// rule, so it lives here rather than in domain: a request body's shape is a
// wire-transport concern. If the app or entity can't be resolved, this
// simply has nothing to check — domain.Create/Update will independently
// resolve and report the real app_not_found/entity_not_found error.
//
// Deliberate contract (not incidental): when unknown fields are present,
// this short-circuits with 400 before domain.Create/Update is ever called,
// so the response never mixes an "unknown field" issue with a per-field
// domain-validation issue (e.g. a separate, valid field's missing-required
// error) — the two are reported in separate requests if both are present.
// This keeps the wire-shape question ("is this body even addressed to this
// schema") fully separate from the domain-semantics question ("is this
// data valid"), and keeps domain.Create/Update's contract simple: if they
// run at all, every key in body was already a known field, and — the
// property that matters most — a request with unknown fields can never
// cause a row to be inserted or updated, since domain is never invoked.
func (s *Server) unknownFieldIssues(appID, entName string, body map[string]json.RawMessage) []domain.FieldError {
	ra, ok := s.reg.App(appID)
	if !ok {
		return nil
	}
	ent := ra.Schema.Entity(entName)
	if ent == nil {
		return nil
	}
	var issues []domain.FieldError
	for key := range body {
		if ent.Field(key) == nil {
			issues = append(issues, domain.FieldError{Field: key, Message: "unknown field"})
		}
	}
	return issues
}

// decodeBody reads a JSON object body into raw per-key messages, deferring
// per-field decoding to domain. A non-object or malformed body is a 400.
//
// Deliberate contract (not incidental): decodeBody runs before any
// app/entity resolution in handleCreate/handleUpdate, so a malformed body
// against an unknown app returns 400 invalid_body, not 404 app_not_found.
// This is the natural consequence of a strict pipeline ordering — HTTP-level
// structural validity (is this even parseable JSON?) gates domain
// resolution (does this app/entity exist?), never the other way around —
// which also matches how every handler is actually structured: there is no
// well-formed map[string]json.RawMessage to hand to domain.Create/Update
// until the body has already been decoded, so decoding first isn't a
// choice made per request, it's what the adapter's data flow requires.
func decodeBody(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	defer r.Body.Close()
	data, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "could not read request body")
		return nil, false
	}
	if len(data) == 0 {
		return map[string]json.RawMessage{}, true
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(data, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "request body must be a JSON object")
		return nil, false
	}
	return body, true
}

// writeValidationError writes the standard 400 body-validation shape for a
// non-empty issue list.
func writeValidationError(w http.ResponseWriter, issues []domain.FieldError) {
	details := make([]any, len(issues))
	for i, iss := range issues {
		details[i] = iss
	}
	writeError(w, http.StatusBadRequest, "validation_failed", "request body failed validation", details...)
}

// writeOpError maps a domain operation's structured error onto this API's
// wire contract — the one place that translates domain.ErrorKind into an
// HTTP status code, error code, and message.
func writeOpError(w http.ResponseWriter, operr *domain.OpError) {
	switch operr.Kind {
	case domain.ErrAppNotFound:
		writeError(w, http.StatusNotFound, "app_not_found", operr.Message)
	case domain.ErrEntityNotFound:
		writeError(w, http.StatusNotFound, "entity_not_found", operr.Message)
	case domain.ErrOperationDisabled:
		writeError(w, http.StatusMethodNotAllowed, "operation_disabled", operr.Message)
	case domain.ErrValidation:
		writeValidationError(w, operr.Issues)
	case domain.ErrInvalidQuery:
		details := make([]any, len(operr.Issues))
		for i, iss := range operr.Issues {
			details[i] = iss
		}
		writeError(w, http.StatusBadRequest, "invalid_query", operr.Message, details...)
	case domain.ErrRowNotFound:
		writeError(w, http.StatusNotFound, "row_not_found", operr.Message)
	case domain.ErrUnique:
		writeError(w, http.StatusConflict, "unique_violation", operr.Message)
	case domain.ErrReferenceConflict:
		writeError(w, http.StatusConflict, "reference_conflict", operr.Message)
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", operr.Message)
	}
}
