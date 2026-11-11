package adminapi

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"pocketknife/consent"
	"pocketknife/lifecycle"
	"pocketknife/migrate"
	"pocketknife/registry"
	"pocketknife/schema"
	"pocketknife/store"
	"pocketknife/validate"
)

type migrationChange struct {
	Kind        string `json:"kind"`
	Description string `json:"description"`
	Destructive bool   `json:"destructive"`
}

func (s *Server) handleChanges(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := r.PathValue("id")
	if !lifecycle.ValidID(id) {
		writeError(w, 400, "invalid_id", "invalid app id")
		return
	}
	old, ok := s.reg.LoadedApp(id)
	if !ok {
		old = &registry.RegisteredApp{Schema: &schema.App{ID: id}}
	}
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		writeError(w, 400, "invalid_body", "manifest exceeds the size limit")
		return
	}
	next, errs := validate.Manifest(raw)
	if len(errs) > 0 {
		writeJSON(w, 422, map[string]any{"valid": false, "errors": errs})
		return
	}
	if next.ID != id {
		writeError(w, 422, "id_mismatch", "app identity cannot change")
		return
	}
	cs := migrate.Diff(old.Schema, next)
	cs.Classify()
	changes := []migrationChange{}
	for _, op := range cs.Ops {
		changes = append(changes, migrationChange{string(op.Kind), op.String(), op.Class == migrate.ClassDestructive})
	}
	delta := consent.Widened(old.Schema, next)
	data := []string{}
	for _, grant := range delta.NewData {
		data = append(data, grant.EntityID+":"+string(grant.Operation))
	}
	writeJSON(w, 200, map[string]any{"migration": changes, "permissions": map[string]any{"network": delta.NewNetwork, "model": delta.NewModel, "data": data}, "requiresConfirmation": cs.HasDestructive() || delta.RequiresReconsent()})
}

// applyBundle is the single reviewed activation path. Source is staged before
// migrating; database and catalog are restored if activation fails. Existing
// data is never recreated and a disabled app stays disabled.
func (s *Server) applyBundle(w http.ResponseWriter, r *http.Request, id string, next *schema.App, req saveRequest) {
	old, exists := s.reg.LoadedApp(id)
	status, _ := s.reg.Status(id)
	var cs *migrate.Changeset
	if !exists && !consent.Union(next).IsEmpty() && !req.Confirm {
		writeError(w, 409, "confirmation_required", "Review and approve the new app's function capabilities before launching.")
		return
	}
	if exists {
		cs = migrate.Diff(old.Schema, next)
		cs.Classify()
		if (cs.HasDestructive() || consent.Widened(old.Schema, next).RequiresReconsent()) && !req.Confirm {
			writeError(w, 409, "confirmation_required", "Review and acknowledge schema removals or new capabilities before applying.")
			return
		}
		if missing := cs.MissingWitnesses(); len(missing) > 0 {
			ops := []string{}
			for _, op := range missing {
				ops = append(ops, op.String())
			}
			writeError(w, 422, "migration_witness_required", "These changes need a data conversion/backfill before they can be applied: "+strings.Join(ops, "; ")+". Keep fields optional or provide defaults; preserve stable IDs when renaming.")
			return
		}
	}
	stage, err := os.MkdirTemp(s.catalogDir, ".workspace-apply-")
	if err != nil {
		writeError(w, 500, "stage_failed", err.Error())
		return
	}
	defer os.RemoveAll(stage)
	if err = writeAppBundle(stage, id, req); err != nil {
		writeError(w, 500, "stage_failed", err.Error())
		return
	}
	var snapshot string
	if exists && !cs.IsEmpty() {
		snapshot, err = migrate.Snapshot(old.Store, filepath.Join(s.dataDir, id, ".snapshots"))
		if err != nil {
			writeError(w, 500, "snapshot_failed", err.Error())
			return
		}
	}
	appDir := filepath.Join(s.catalogDir, id)
	backup := filepath.Join(stage, "previous")
	hadDir := false
	if _, err := os.Stat(appDir); err == nil {
		hadDir = true
	}
	if exists {
		s.reg.Deactivate(id)
	}
	restoreRegistration := func(st *store.Store) {
		s.reg.Register(&registry.RegisteredApp{Schema: old.Schema, Store: st, Dir: old.Dir})
		if status == "inactive" {
			s.reg.Deactivate(id)
		}
	}
	rollback := func(cause error, migrated bool) {
		if hadDir {
			if _, err := os.Stat(backup); err == nil {
				_ = os.RemoveAll(appDir)
				if err := os.Rename(backup, appDir); err != nil {
					cause = fmt.Errorf("%v; source restore failed: %w", cause, err)
				}
			}
		} else {
			_ = os.RemoveAll(appDir)
		}
		if exists {
			st := old.Store
			if migrated && snapshot != "" {
				_ = st.Close()
				if err := migrate.Restore(snapshot, st.Path()); err != nil {
					writeError(w, 500, "restore_failed", fmt.Sprintf("%v; database restore failed: %v", cause, err))
					return
				}
				st, err = store.Open(st.Path())
				if err != nil {
					writeError(w, 500, "restore_failed", err.Error())
					return
				}
			}
			restoreRegistration(st)
		}
		writeError(w, 422, "apply_failed", cause.Error())
	}
	if exists && !cs.IsEmpty() {
		if err := migrate.Execute(r.Context(), old.Store, old.Schema, next, cs); err != nil {
			rollback(err, false)
			return
		}
	}
	if hadDir {
		if err := os.Rename(appDir, backup); err != nil {
			rollback(err, true)
			return
		}
	}
	if err := os.Rename(filepath.Join(stage, id), appDir); err != nil {
		rollback(err, true)
		return
	}
	if exists {
		s.reg.Register(&registry.RegisteredApp{Schema: next, Store: old.Store, Dir: appDir})
		if status == "inactive" {
			s.reg.Deactivate(id)
		}
	} else {
		result := lifecycle.Install(s.reg, s.catalogDir, s.dataDir, id)
		if !result.OK {
			// A failed first seed must not leave a partially initialized database
			// that a retry would incorrectly treat as an existing, already-seeded app.
			if result.Fresh {
				for _, suffix := range []string{"", "-wal", "-shm"} {
					_ = os.Remove(filepath.Join(s.dataDir, id, "data.db") + suffix)
				}
			}
			rollback(fmt.Errorf("app initialization failed: %v %v", result.Errors, result.Err), false)
			return
		}
	}
	if snapshot != "" {
		_ = migrate.Prune(filepath.Dir(snapshot), migrate.DefaultRetention)
	}
	writeJSON(w, 200, map[string]any{"id": id, "status": func() string {
		if status == "inactive" {
			return status
		}
		return "active"
	}()})
}
