// Package lifecycle drives runtime app registration for the admin API: it
// composes registry.LoadApp (validate + materialize + open store) with
// seed.Apply (starter data on an app's first boot) exactly the way
// cmd/pocketknife/main.go's serve path does at process boot, so installing
// or reinstalling an app after the process has already started goes through
// the same gates a restart would -- no separate, weaker path.
//
// Activate and Deactivate need no equivalent here: they only move an
// already-loaded app between registry.Registry's active/inactive sets, so
// the registry's own methods are the whole implementation; see adminapi.
package lifecycle

import (
	"fmt"
	"path/filepath"
	"regexp"

	"pocketknife/registry"
	"pocketknife/seed"
)

// idPattern is the manifest schema's stableId pattern -- the same rule
// app.id must satisfy. Any caller turning a caller-supplied string into a
// filesystem path under catalogDir must check it against this first: an
// app.id that hasn't been validated could otherwise be used for a path
// traversal (e.g. "../../etc").
var idPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// ValidID reports whether id is a syntactically valid app ID.
func ValidID(id string) bool {
	return idPattern.MatchString(id)
}

// Install loads catalogDir/<appID>/manifest.json, materializes and opens its
// database under dataDir, seeds starter data if the database was just
// created, and registers the result into reg (active, immediately
// servable) -- or leaves reg untouched and returns a non-OK result if any
// step failed. Calling Install again for an app already in reg (e.g. after
// editing its manifest) reinstalls it in place: registry.Register closes
// the previous store handle for you.
//
// The caller must check ValidID(appID) itself before calling Install --
// this function trusts appID enough to join it onto catalogDir unchecked.
func Install(reg *registry.Registry, catalogDir, dataDir, appID string) registry.LoadResult {
	manifestPath := filepath.Join(catalogDir, appID, "manifest.json")
	ra, res := registry.LoadApp(manifestPath, dataDir)
	if !res.OK {
		return res
	}

	if res.Fresh {
		if _, err := seed.Apply(ra); err != nil {
			ra.Store.Close()
			res.OK = false
			res.Err = fmt.Errorf("seed data failed: %w", err)
			return res
		}
	}

	reg.Register(ra)
	return res
}
