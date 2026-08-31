package lifecycle_test

import (
	"os"
	"path/filepath"
	"testing"

	"pocketknife/lifecycle"
	"pocketknife/registry"
)

func writeManifest(t *testing.T, catalogDir, appID, body string) {
	t.Helper()
	dir := filepath.Join(catalogDir, appID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const notesV1 = `{
  "app": { "id": "notes", "name": "Notes", "version": 1 },
  "entities": [ { "id": "ent_note", "name": "note", "fields": [
    { "id": "fld_title", "name": "title", "type": "text", "required": true }
  ]}]
}`

func TestInstallOnEmptyRegistryRegistersAndServes(t *testing.T) {
	catalogDir, dataDir := t.TempDir(), t.TempDir()
	writeManifest(t, catalogDir, "notes", notesV1)

	reg := registry.New()
	defer reg.Close()

	res := lifecycle.Install(reg, catalogDir, dataDir, "notes")
	if !res.OK {
		t.Fatalf("install failed: %v %v", res.Errors, res.Err)
	}
	if !res.Fresh {
		t.Fatal("expected a brand-new app's database to be reported fresh")
	}
	if _, ok := reg.App("notes"); !ok {
		t.Fatal("Install must register the app so it's immediately servable")
	}
}

func TestInstallTwiceReinstallsInPlaceWithoutLeakingTheOldStore(t *testing.T) {
	catalogDir, dataDir := t.TempDir(), t.TempDir()
	writeManifest(t, catalogDir, "notes", notesV1)

	reg := registry.New()
	defer reg.Close()

	first := lifecycle.Install(reg, catalogDir, dataDir, "notes")
	if !first.OK {
		t.Fatalf("first install failed: %v %v", first.Errors, first.Err)
	}
	before, _ := reg.App("notes")

	second := lifecycle.Install(reg, catalogDir, dataDir, "notes")
	if !second.OK {
		t.Fatalf("second install failed: %v %v", second.Errors, second.Err)
	}
	if second.Fresh {
		t.Fatal("reinstalling an already-materialized app must not be reported fresh")
	}

	after, ok := reg.App("notes")
	if !ok {
		t.Fatal("app must still be active after reinstall")
	}
	if after == before {
		t.Fatal("expected a reinstall to open a new RegisteredApp/Store pair")
	}
}

func TestInstallInvalidManifestLeavesRegistryUntouched(t *testing.T) {
	catalogDir, dataDir := t.TempDir(), t.TempDir()
	// Reserved field name "id" -> fails validation.
	writeManifest(t, catalogDir, "bad", `{
      "app": { "id": "bad", "name": "Bad", "version": 1 },
      "entities": [ { "id": "ent_x", "name": "x", "fields": [
        { "id": "fld_id", "name": "id", "type": "text" }
      ]}]
    }`)

	reg := registry.New()
	defer reg.Close()

	res := lifecycle.Install(reg, catalogDir, dataDir, "bad")
	if res.OK {
		t.Fatal("expected install of an invalid manifest to fail")
	}
	if len(res.Errors) == 0 {
		t.Fatal("expected structured validation errors")
	}
	if _, ok := reg.App("bad"); ok {
		t.Fatal("an invalid app must never be registered")
	}
}

func TestInstallUnknownAppDirFails(t *testing.T) {
	catalogDir, dataDir := t.TempDir(), t.TempDir()
	reg := registry.New()
	defer reg.Close()

	res := lifecycle.Install(reg, catalogDir, dataDir, "missing")
	if res.OK {
		t.Fatal("expected install of a nonexistent app directory to fail")
	}
	if _, ok := reg.App("missing"); ok {
		t.Fatal("a failed install must not register anything")
	}
}

// TestInstallSeedFailureUnregistersRatherThanServePartiallySeeded proves
// Install applies the same hard-gate posture main.go's boot path does: a
// seed failure on a fresh app's first install must not leave it registered
// half-seeded.
func TestInstallSeedFailureUnregistersRatherThanServePartiallySeeded(t *testing.T) {
	catalogDir, dataDir := t.TempDir(), t.TempDir()
	writeManifest(t, catalogDir, "notes", notesV1)

	dataFilesDir := filepath.Join(catalogDir, "notes", "data")
	if err := os.MkdirAll(dataFilesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// "widget" matches no entity in notesV1 -> seed.Apply must fail.
	if err := os.WriteFile(filepath.Join(dataFilesDir, "widget.json"), []byte(`[{"name":"x"}]`), 0o644); err != nil {
		t.Fatal(err)
	}

	reg := registry.New()
	defer reg.Close()

	res := lifecycle.Install(reg, catalogDir, dataDir, "notes")
	if res.OK {
		t.Fatal("expected install to fail when seed data doesn't match any entity")
	}
	if res.Err == nil {
		t.Fatal("expected a seed-failure error")
	}
	if _, ok := reg.App("notes"); ok {
		t.Fatal("an app whose seed failed must never be registered")
	}
}

func TestValidID(t *testing.T) {
	cases := map[string]bool{
		"notes":        true,
		"reading_v2":   true,
		"":             false,
		"Notes":        false,
		"1notes":       false,
		"../../etc":    false,
		"notes/../etc": false,
	}
	for id, want := range cases {
		if got := lifecycle.ValidID(id); got != want {
			t.Errorf("ValidID(%q) = %v, want %v", id, got, want)
		}
	}
}
