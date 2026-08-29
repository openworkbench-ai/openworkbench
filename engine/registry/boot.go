package registry

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"pocketknife/materialize"
	"pocketknife/schema"
	"pocketknife/store"
	"pocketknife/validate"
)

// LoadResult records the outcome of processing one manifest during boot. It lets
// the caller log skipped (invalid) manifests without aborting the whole boot.
type LoadResult struct {
	Dir          string
	ManifestPath string
	AppID        string
	OK           bool
	// Fresh is true when this app's data.db did not exist on disk before this
	// Load call created it -- the signal a caller uses to seed starter data
	// exactly once, on an app's very first boot (see the seed package).
	Fresh  bool
	Errors validate.Errors
	Err    error
}

// Load scans appsDir for */manifest.json, then for each: validates (the hard
// gate), materializes its database idempotently, and registers the compiled
// schema. Each app's data.db lives under dataDir/<app_id>/, kept separate
// from the catalog entry (manifest, seed data, agent skills) so the catalog
// stays purely declarative and safe to check into version control. An
// invalid or unprocessable manifest is recorded in the returned results and
// skipped — never served — but does not stop the others.
//
// After materializing, Load runs two independent consistency checks before
// ever registering an app. Store.VerifySchema catches a database whose
// actual columns don't match the manifest's declared fields — CREATE TABLE
// IF NOT EXISTS is a no-op against an existing, differently-shaped table, so
// this is the only thing standing between a stale data.db and an app being
// served against a schema it no longer has. VerifySchema only compares
// column names, though: it can't see a constraint-only change (required,
// unique, a reference's target/onDelete, an enum's value set, a min/max
// bound) where the columns themselves haven't changed. schema.Fingerprint
// closes that gap — a deterministic digest of exactly the parts of the
// manifest that determine materialized schema semantics, compared against
// the fingerprint last recorded after a schema change actually succeeded
// (Store.AppliedFingerprint/SetAppliedFingerprint, kept inside the app's own
// data.db so a migration rollback restores the old fingerprint for free).
// An app with no recorded fingerprint yet — brand new, or predating this
// mechanism — adopts the manifest's fingerprint as its baseline, but only
// once VerifySchema has already shown the database's columns are consistent
// with it; a legacy app that was already constraint-mismatched at the
// moment of upgrading past this point stays undetected for that one
// transition, a documented, accepted limitation of adopting the mechanism
// after the fact. Both checks are detection only: Load never migrates data
// or rewrites a manifest on an app's behalf.
func Load(appsDir, dataDir string) (*Registry, []LoadResult, error) {
	matches, err := filepath.Glob(filepath.Join(appsDir, "*", "manifest.json"))
	if err != nil {
		return nil, nil, fmt.Errorf("scan apps dir: %w", err)
	}
	sort.Strings(matches)

	reg := New()
	var results []LoadResult

	for _, manifestPath := range matches {
		dir := filepath.Dir(manifestPath)
		res := LoadResult{Dir: dir, ManifestPath: manifestPath}

		data, err := os.ReadFile(manifestPath)
		if err != nil {
			res.Err = fmt.Errorf("read manifest: %w", err)
			results = append(results, res)
			continue
		}

		app, verrs := validate.Manifest(data)
		if len(verrs) > 0 {
			res.Errors = verrs
			results = append(results, res)
			continue
		}
		res.AppID = app.ID

		stmts, err := materialize.Statements(app)
		if err != nil {
			res.Err = fmt.Errorf("materialize: %w", err)
			results = append(results, res)
			continue
		}

		appDataDir := filepath.Join(dataDir, app.ID)
		if err := os.MkdirAll(appDataDir, 0o755); err != nil {
			res.Err = fmt.Errorf("create data dir: %w", err)
			results = append(results, res)
			continue
		}

		dbPath := filepath.Join(appDataDir, "data.db")
		_, statErr := os.Stat(dbPath)
		res.Fresh = os.IsNotExist(statErr)

		st, err := store.Open(dbPath)
		if err != nil {
			res.Err = fmt.Errorf("open store: %w", err)
			results = append(results, res)
			continue
		}
		if err := st.ApplyDDL(stmts); err != nil {
			st.Close()
			res.Err = fmt.Errorf("apply ddl: %w", err)
			results = append(results, res)
			continue
		}

		if err := st.VerifySchema(app); err != nil {
			st.Close()
			res.Err = fmt.Errorf("manifest/database consistency check failed: %w", err)
			results = append(results, res)
			continue
		}

		if err := checkSchemaFingerprint(st, app); err != nil {
			st.Close()
			res.Err = fmt.Errorf("manifest/database consistency check failed: %w", err)
			results = append(results, res)
			continue
		}

		reg.Register(&RegisteredApp{Schema: app, Store: st, Dir: dir})
		res.OK = true
		results = append(results, res)
	}

	return reg, results, nil
}

// checkSchemaFingerprint enforces that app's current schema fingerprint
// matches the one last recorded after a schema change actually succeeded.
// If none has ever been recorded (a brand-new app whose fresh materialize
// just ran above, or a legacy app predating this mechanism), it adopts the
// manifest's fingerprint as the baseline — safe to do here specifically
// because the caller has already run VerifySchema first and found the
// database's columns consistent with app.
func checkSchemaFingerprint(st *store.Store, app *schema.App) error {
	fp := schema.Fingerprint(app)
	applied, ok, err := st.AppliedFingerprint()
	if err != nil {
		return err
	}
	if !ok {
		return st.SetAppliedFingerprint(fp)
	}
	if applied != fp {
		return fmt.Errorf("schema fingerprint mismatch: the manifest changed without a successful migration ever being applied to this app's database (applied=%s, manifest=%s)", applied, fp)
	}
	return nil
}
