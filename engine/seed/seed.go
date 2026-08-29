// Package seed inserts starter rows from an app's optional catalog/<id>/data/
// folder, but only the very first time that app's database is created.
// registry.Load detects "freshly created"; the caller (main.go's serve path)
// invokes Apply exactly once per app, for that one boot, before the app is
// ever exposed to a request.
//
// Each file in data/ is named after an entity (by name, not stable id) and
// holds a JSON array of row objects shaped exactly like a Create request
// body. A reserved "$key" string per row labels that row for later files to
// reference: a reference-typed field's value must be a "$<entity_name>.<key>"
// placeholder, resolved to the row's real generated id. Entities seed in the
// manifest's declared order -- the same order materialize.Statements emits
// CREATE TABLE in -- so a manifest must declare (and its data/ files must
// seed) a referenced entity before whatever references it. There is no
// cycle or self-reference support, matching the rest of the schema/validate/
// materialize pipeline.
//
// All inserts for one app run inside a single transaction: any error --  an
// unknown seed filename, a row that fails validation, an unresolved
// reference -- rolls back every row this call would otherwise have
// inserted, so an app either seeds completely or not at all.
package seed

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"pocketknife/domain"
	"pocketknife/registry"
	"pocketknife/schema"
)

// keyField is the reserved per-row label used for cross-entity references.
// It is never inserted as a real field value.
const keyField = "$key"

// Apply seeds ra's database from catalog/<id>/data/, if that directory exists.
// It is a no-op (seeded=false) if the directory is absent or empty of
// recognized seed files -- most apps have no seed data.
func Apply(ra *registry.RegisteredApp) (seeded bool, err error) {
	dir := filepath.Join(ra.Dir, "data")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("read seed data dir: %w", err)
	}

	files := map[string]string{} // entity name -> seed file path
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".json")
		ent := ra.Schema.Entity(name)
		if ent == nil {
			return false, fmt.Errorf("seed file %q does not match any entity name", e.Name())
		}
		if !ent.Allows(schema.OpCreate) {
			return false, fmt.Errorf("seed file %q targets entity %q, which does not allow create", e.Name(), name)
		}
		files[name] = filepath.Join(dir, e.Name())
	}
	if len(files) == 0 {
		return false, nil
	}

	tx, err := ra.Store.BeginTx(context.Background())
	if err != nil {
		return false, fmt.Errorf("begin seed transaction: %w", err)
	}

	keys := map[string]string{} // "<entity_name>.<key>" -> generated row id
	for _, ent := range ra.Schema.Entities {
		path, ok := files[ent.Name]
		if !ok {
			continue
		}
		if err := seedEntity(tx, ra, ent, path, keys); err != nil {
			tx.Rollback()
			return false, fmt.Errorf("seed entity %q: %w", ent.Name, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit seed transaction: %w", err)
	}
	return true, nil
}

// seedEntity inserts every row declared in path against ent, resolving any
// reference-field placeholders against keys already seen (rows from
// entities processed earlier in this call) and recording its own rows'
// "$key" labels into keys for entities processed later.
func seedEntity(rs domain.RowStore, ra *registry.RegisteredApp, ent *schema.Entity, path string, keys map[string]string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}

	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(data, &rows); err != nil {
		return fmt.Errorf("%s: must be a JSON array of row objects: %w", path, err)
	}

	for i, row := range rows {
		var seedKey string
		if raw, ok := row[keyField]; ok {
			if err := json.Unmarshal(raw, &seedKey); err != nil {
				return fmt.Errorf("%s: row %d: %q must be a string", path, i, keyField)
			}
			delete(row, keyField)
		}

		if err := resolveReferences(row, ent, keys); err != nil {
			return fmt.Errorf("%s: row %d: %w", path, i, err)
		}

		created, operr := domain.CreateIn(rs, ra, ent, row)
		if operr != nil {
			return fmt.Errorf("%s: row %d: %s", path, i, operr.Message)
		}

		if seedKey != "" {
			id, ok := created["id"].(string)
			if !ok {
				return fmt.Errorf("%s: row %d: inserted row has no string id", path, i)
			}
			keys[ent.Name+"."+seedKey] = id
		}
	}
	return nil
}

// resolveReferences rewrites every reference-typed field present in row from
// a "$<entity_name>.<key>" placeholder to the real id it names, in place.
func resolveReferences(row map[string]json.RawMessage, ent *schema.Entity, keys map[string]string) error {
	for _, f := range ent.Fields {
		if f.Type != schema.TypeReference {
			continue
		}
		raw, ok := row[f.Name]
		if !ok {
			continue
		}

		var placeholder string
		if err := json.Unmarshal(raw, &placeholder); err != nil {
			return fmt.Errorf("field %q must be a %q reference placeholder string", f.Name, "$entity.key")
		}
		if !strings.HasPrefix(placeholder, "$") {
			return fmt.Errorf("field %q value %q is not a $<entity>.<key> reference placeholder", f.Name, placeholder)
		}
		resolved, ok := keys[strings.TrimPrefix(placeholder, "$")]
		if !ok {
			return fmt.Errorf("field %q references unresolved key %q (the referenced entity must be declared, and seeded, earlier in the manifest)", f.Name, placeholder)
		}

		marshaled, err := json.Marshal(resolved)
		if err != nil {
			return err
		}
		row[f.Name] = marshaled
	}
	return nil
}
