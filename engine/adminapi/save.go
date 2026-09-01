// save.go implements PUT /admin/apps/{id}: the one write path a caller --
// eventually the builder agent -- uses to place or replace an app's on-disk
// content (manifest, skills, seed data) before calling install. It never
// registers or activates anything itself; see handleInstall for that.
package adminapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"

	"pocketknife/lifecycle"
	"pocketknife/validate"
)

// maxSaveBytes bounds the request body. Bundles can include seed data and
// built MCP Apps UI components -- each a full React+Tailwind runtime inlined
// by vite-plugin-singlefile, easily several MB apiece once JSON-escaped -- so
// this is far more generous than validateapi's manifest-only cap.
const maxSaveBytes = 64 << 20

// skillNamePattern is the same stableId-style shape lifecycle.ValidID checks
// for app IDs, applied to a second caller-supplied identifier that also
// becomes a filesystem path segment (skills/<name>/SKILL.md).
var skillNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)

type saveSkill struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type saveDataFile struct {
	Entity string            `json:"entity"`
	Rows   []json.RawMessage `json:"rows"`
}

// saveUIComponent is one tool's built MCP Apps resource: the self-contained
// HTML/JS bundle Vite produced from ui/components/<Name>.tsx (see
// packages/app-ui-kit). Name must match a tool's manifest.json ui.component.
type saveUIComponent struct {
	Name string `json:"name"`
	HTML string `json:"html"`
}

type saveRequest struct {
	Manifest json.RawMessage   `json:"manifest"`
	Skills   []saveSkill       `json:"skills,omitempty"`
	Data     []saveDataFile    `json:"data,omitempty"`
	UI       []saveUIComponent `json:"ui,omitempty"`
}

// uiComponentNamePattern mirrors manifest.schema.json's tool.ui.component
// pattern -- Name becomes a filesystem path segment (ui/<name>.html).
var uiComponentNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*$`)

func (s *Server) handleSave(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !lifecycle.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid_id", "app id must match ^[a-z][a-z0-9_]*$")
		return
	}

	defer r.Body.Close()
	// Read one byte past the cap so an oversized body can be reported as
	// "too large" rather than silently truncated into invalid JSON that
	// then gets misreported as a missing "manifest" field.
	body, err := io.ReadAll(io.LimitReader(r.Body, maxSaveBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "could not read request body")
		return
	}
	if len(body) > maxSaveBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "body_too_large",
			fmt.Sprintf("request body exceeds the %d byte limit", maxSaveBytes))
		return
	}

	var req saveRequest
	if jsonErr := json.Unmarshal(body, &req); jsonErr != nil || len(req.Manifest) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_body", "expected a JSON object with a \"manifest\" field")
		return
	}

	app, verrs := validate.Manifest(req.Manifest)
	if len(verrs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"valid": false, "errors": verrs})
		return
	}
	// The registry keys apps by the manifest's own app.id (see
	// registry.Register), not by the URL segment or directory name. Without
	// this check, a mismatched bundle would write to catalogDir/{id} but
	// register (on install) under a different id, leaving the URL id
	// unresolvable by any later activate/deactivate/install call.
	if app.ID != id {
		writeError(w, http.StatusUnprocessableEntity, "id_mismatch",
			fmt.Sprintf("manifest app.id %q does not match the URL id %q", app.ID, id))
		return
	}

	for _, skill := range req.Skills {
		if !skillNamePattern.MatchString(skill.Name) {
			writeError(w, http.StatusBadRequest, "invalid_skill_name",
				fmt.Sprintf("skill name %q must match ^[a-z][a-z0-9_-]*$", skill.Name))
			return
		}
	}
	for _, d := range req.Data {
		if d.Entity == "" {
			writeError(w, http.StatusBadRequest, "invalid_data_entity", "each data entry needs a non-empty \"entity\" name")
			return
		}
	}

	builtUI := make(map[string]bool, len(req.UI))
	for _, ui := range req.UI {
		if !uiComponentNamePattern.MatchString(ui.Name) {
			writeError(w, http.StatusBadRequest, "invalid_ui_component_name",
				fmt.Sprintf("ui component name %q must match ^[A-Za-z][A-Za-z0-9]*$", ui.Name))
			return
		}
		builtUI[ui.Name] = true
	}
	for _, tool := range app.Tools {
		if tool.UI != nil && !builtUI[tool.UI.Component] {
			writeError(w, http.StatusUnprocessableEntity, "missing_ui_component",
				fmt.Sprintf("tool %q declares ui.component %q, but no built ui/%s.html was submitted",
					tool.Name, tool.UI.Component, tool.UI.Component))
			return
		}
	}

	if err := writeAppBundle(s.catalogDir, id, req); err != nil {
		writeError(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"valid": true})
}

// writeAppBundle stages manifest.json, one skills/<name>/SKILL.md per skill,
// one data/<entity>.json per data entry, and one ui/<name>.html per built MCP
// Apps component in a fresh temp directory inside catalogDir (so the final
// swap is a same-filesystem rename), then swaps it in for catalogDir/<id>.
// Any previous contents are moved aside rather than deleted until the swap is
// confirmed, so a failure partway through leaves the previous app dir intact
// instead of half-overwritten.
func writeAppBundle(catalogDir, id string, req saveRequest) error {
	stagingDir, err := os.MkdirTemp(catalogDir, ".save-"+id+"-")
	if err != nil {
		return fmt.Errorf("stage temp dir: %w", err)
	}
	defer os.RemoveAll(stagingDir) // no-op once successfully renamed into place

	manifestOut, err := reindentJSON(req.Manifest)
	if err != nil {
		return fmt.Errorf("re-encode manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "manifest.json"), manifestOut, 0o644); err != nil {
		return fmt.Errorf("write manifest.json: %w", err)
	}

	if len(req.Skills) > 0 {
		skillsDir := filepath.Join(stagingDir, "skills")
		if err := os.Mkdir(skillsDir, 0o755); err != nil {
			return fmt.Errorf("create skills dir: %w", err)
		}
		for _, skill := range req.Skills {
			dir := filepath.Join(skillsDir, skill.Name)
			if err := os.Mkdir(dir, 0o755); err != nil {
				return fmt.Errorf("create skill dir %q: %w", skill.Name, err)
			}
			if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(skill.Content), 0o644); err != nil {
				return fmt.Errorf("write skill %q: %w", skill.Name, err)
			}
		}
	}

	if len(req.Data) > 0 {
		dataDir := filepath.Join(stagingDir, "data")
		if err := os.Mkdir(dataDir, 0o755); err != nil {
			return fmt.Errorf("create data dir: %w", err)
		}
		for _, d := range req.Data {
			rowsOut, err := json.MarshalIndent(d.Rows, "", "  ")
			if err != nil {
				return fmt.Errorf("encode seed data for %q: %w", d.Entity, err)
			}
			if err := os.WriteFile(filepath.Join(dataDir, d.Entity+".json"), rowsOut, 0o644); err != nil {
				return fmt.Errorf("write seed data for %q: %w", d.Entity, err)
			}
		}
	}

	if len(req.UI) > 0 {
		uiDir := filepath.Join(stagingDir, "ui")
		if err := os.Mkdir(uiDir, 0o755); err != nil {
			return fmt.Errorf("create ui dir: %w", err)
		}
		for _, ui := range req.UI {
			if err := os.WriteFile(filepath.Join(uiDir, ui.Name+".html"), []byte(ui.HTML), 0o644); err != nil {
				return fmt.Errorf("write ui component %q: %w", ui.Name, err)
			}
		}
	}

	appDir := filepath.Join(catalogDir, id)
	backupDir := filepath.Join(catalogDir, ".save-backup-"+id)
	_ = os.RemoveAll(backupDir) // clear any stale backup left by a previous crash

	hadExisting := false
	if _, statErr := os.Stat(appDir); statErr == nil {
		if err := os.Rename(appDir, backupDir); err != nil {
			return fmt.Errorf("back up existing app dir: %w", err)
		}
		hadExisting = true
	}

	if err := os.Rename(stagingDir, appDir); err != nil {
		if hadExisting {
			_ = os.Rename(backupDir, appDir) // best-effort restore of the previous state
		}
		return fmt.Errorf("activate new app dir: %w", err)
	}

	if hadExisting {
		_ = os.RemoveAll(backupDir)
	}
	return nil
}

// reindentJSON re-serializes raw manifest bytes through the standard decode
// path -- structurally a no-op, but it normalizes whitespace and guarantees
// what lands on disk is exactly the JSON validate.Manifest just accepted.
func reindentJSON(raw json.RawMessage) ([]byte, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return json.MarshalIndent(v, "", "  ")
}
