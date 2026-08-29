package migrate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"pocketknife/registry"
	"pocketknife/store"
	"pocketknife/validate"
)

// Options controls a single apply-changeset run.
type Options struct {
	// Confirm must be true for a changeset containing destructive operations to
	// run. It is the explicit, human acknowledgement the engine requires; it is
	// never implied.
	Confirm bool
	// Witnesses supplies the declared coercion/backfill/remap rules, keyed by the
	// stable field id they apply to.
	Witnesses map[string]*Witness
}

// Result describes the outcome of Apply.
type Result struct {
	Changeset    *Changeset // computed and classified
	NoChange     bool       // the manifests were structurally identical
	SnapshotPath string     // set when a snapshot was taken (destructive runs)
}

// Apply runs the full apply-changeset flow for one registered app:
//
//	validate(new manifest) → diff(old, new) → classify →
//	  if destructive: require an explicit confirm and the needed witnesses →
//	  snapshot → execute (one transaction) → promote the manifest + re-register;
//	  on any execution failure: restore the snapshot and keep the prior registration.
//
// The app's currently registered schema is the "old" side; newManifest is the
// proposed next version. Nothing here calls an LLM or a shell — it is the headless
// trusted-core entry point that the CLI drives.
func Apply(ctx context.Context, reg *registry.Registry, appID string, newManifest []byte, opts Options) (*Result, error) {
	ra, ok := reg.App(appID)
	if !ok {
		return nil, fmt.Errorf("unknown app %q", appID)
	}

	newApp, verrs := validate.Manifest(newManifest)
	if len(verrs) > 0 {
		return nil, fmt.Errorf("new manifest failed validation: %s", verrs.Error())
	}
	if newApp.ID != appID {
		return nil, fmt.Errorf("new manifest app id %q does not match target app %q", newApp.ID, appID)
	}

	oldApp := ra.Schema
	cs := Diff(oldApp, newApp)
	cs.Classify()
	for i := range cs.Ops {
		if w, ok := opts.Witnesses[cs.Ops[i].FieldID]; ok {
			cs.Ops[i].Witness = w
		}
	}

	if cs.IsEmpty() {
		return &Result{Changeset: cs, NoChange: true}, nil
	}

	// Gate destructive operations behind confirmation and the required witnesses.
	if destructive := cs.Destructive(); len(destructive) > 0 {
		if !opts.Confirm {
			return &Result{Changeset: cs}, fmt.Errorf(
				"refusing: %d destructive operation(s) require explicit confirmation:\n%s",
				len(destructive), indentOps(destructive))
		}
		if missing := cs.MissingWitnesses(); len(missing) > 0 {
			return &Result{Changeset: cs}, fmt.Errorf(
				"refusing: %d destructive operation(s) require a witness:\n%s",
				len(missing), indentOps(missing))
		}
	}

	// Snapshot before any destructive change.
	var snapPath string
	snapDir := filepath.Join(ra.Dir, SnapshotDirName)
	if cs.HasDestructive() {
		var err error
		if snapPath, err = Snapshot(ra.Store, snapDir); err != nil {
			return nil, fmt.Errorf("pre-migration snapshot failed: %w", err)
		}
	}

	if err := Execute(ctx, ra.Store, oldApp, newApp, cs); err != nil {
		if snapPath != "" {
			if rerr := restoreInPlace(reg, ra, snapPath); rerr != nil {
				return nil, fmt.Errorf("migration failed (%v); snapshot restore ALSO failed (%v)", err, rerr)
			}
		}
		return nil, fmt.Errorf("migration failed and was rolled back; prior schema kept: %w", err)
	}

	// Success: promote the new manifest on disk (source of truth) and re-register
	// the new schema against the same store handle.
	if err := os.WriteFile(filepath.Join(ra.Dir, "manifest.json"), newManifest, 0o644); err != nil {
		return nil, fmt.Errorf("migration applied but promoting manifest.json failed: %w", err)
	}
	reg.Register(&registry.RegisteredApp{Schema: newApp, Store: ra.Store, Dir: ra.Dir})

	if snapPath != "" {
		_ = Prune(snapDir, DefaultRetention)
	}
	return &Result{Changeset: cs, SnapshotPath: snapPath}, nil
}

// restoreInPlace rolls an app's database back to a snapshot and keeps the prior
// schema registered. The store is closed (a file restore must overwrite it),
// restored byte-for-byte, then reopened.
func restoreInPlace(reg *registry.Registry, ra *registry.RegisteredApp, snapPath string) error {
	dbPath := ra.Store.Path()
	if err := ra.Store.Close(); err != nil {
		return fmt.Errorf("close store for restore: %w", err)
	}
	if err := Restore(snapPath, dbPath); err != nil {
		return err
	}
	st, err := store.Open(dbPath)
	if err != nil {
		return fmt.Errorf("reopen store after restore: %w", err)
	}
	reg.Register(&registry.RegisteredApp{Schema: ra.Schema, Store: st, Dir: ra.Dir})
	return nil
}

// indentOps renders operations one per indented line for human-readable refusals.
func indentOps(ops []Operation) string {
	lines := make([]string, len(ops))
	for i, op := range ops {
		lines[i] = "  - " + op.String()
	}
	return strings.Join(lines, "\n")
}
