package registry_test

import (
	"testing"

	"pocketknife/registry"
	"pocketknife/store"
)

// TestDeactivateThenActivateRoundTrips proves the core toggle contract:
// deactivating an active app makes it invisible to App/Apps without closing
// its store, and activating it again makes it visible without reopening the
// database -- the same *RegisteredApp, same *store.Store, comes back.
func TestDeactivateThenActivateRoundTrips(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "reading_tracker", readingManifest)

	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	for _, r := range results {
		if !r.OK {
			t.Fatalf("boot: %v %v", r.Errors, r.Err)
		}
	}

	before, ok := reg.App("reading_tracker")
	if !ok {
		t.Fatal("expected reading_tracker to be active after boot")
	}

	if !reg.Deactivate("reading_tracker") {
		t.Fatal("Deactivate on an active app must succeed")
	}
	if _, ok := reg.App("reading_tracker"); ok {
		t.Fatal("a deactivated app must not be visible via App")
	}
	if status, ok := reg.Status("reading_tracker"); !ok || status != "inactive" {
		t.Fatalf("Status = %q, %v; want inactive, true", status, ok)
	}

	if !reg.Activate("reading_tracker") {
		t.Fatal("Activate on an inactive app must succeed")
	}
	after, ok := reg.App("reading_tracker")
	if !ok {
		t.Fatal("a reactivated app must be visible via App")
	}
	if after != before {
		t.Fatal("reactivating must return the exact same RegisteredApp, not a reload")
	}
	if after.Store != before.Store {
		t.Fatal("reactivating must not reopen the store")
	}
}

func TestDeactivateUnknownAppFails(t *testing.T) {
	reg := registry.New()
	if reg.Deactivate("nope") {
		t.Fatal("Deactivate on an unknown id must report false")
	}
}

func TestActivateAlreadyActiveAppFails(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "reading_tracker", readingManifest)
	reg, _, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()

	// Activate only ever resumes something already moved to inactive --
	// calling it on an app that's already active (never deactivated) must
	// not silently succeed.
	if reg.Activate("reading_tracker") {
		t.Fatal("Activate on an already-active app must report false")
	}
}

func TestStatusUnknownAppReportsNotOK(t *testing.T) {
	reg := registry.New()
	if _, ok := reg.Status("nope"); ok {
		t.Fatal("Status for an unknown id must report ok=false")
	}
}

// TestRegisterReplacingActiveAppClosesOldStore proves the leak guard: when
// Register is called again for an id that's already active under a
// different store handle, the old handle is closed rather than orphaned.
func TestRegisterReplacingActiveAppClosesOldStore(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "reading_tracker", readingManifest)
	reg, _, err := registry.Load(root, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()

	old, _ := reg.App("reading_tracker")

	// Reinstall from the same on-disk manifest: LoadApp opens a fresh store
	// handle for the same database file.
	next, res := registry.LoadApp(root+"/reading_tracker/manifest.json", root)
	if !res.OK {
		t.Fatalf("reload: %v %v", res.Errors, res.Err)
	}
	reg.Register(next)

	if old.Store.Path() != next.Store.Path() {
		t.Fatal("test setup: expected reinstall to reopen the same database file")
	}
	// The old handle should now be closed; using it must fail rather than
	// silently keep working, which would mean it leaked instead.
	if _, _, err := old.Store.List(old.Schema.Entity("book"), store.ListQuery{Limit: 1}); err == nil {
		t.Fatal("expected the replaced store handle to be closed")
	}

	current, ok := reg.App("reading_tracker")
	if !ok || current != next {
		t.Fatal("Register must serve the new RegisteredApp after replacing the old one")
	}
}
