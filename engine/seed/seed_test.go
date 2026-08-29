package seed_test

import (
	"os"
	"path/filepath"
	"testing"

	"pocketknife/registry"
	"pocketknife/seed"
	"pocketknife/store"
)

const libraryManifest = `{
  "app": { "id": "library", "name": "Library", "version": 1 },
  "entities": [
    { "id": "ent_author", "name": "author", "fields": [
      { "id": "fld_author_name", "name": "name", "type": "text", "required": true }
    ]},
    { "id": "ent_book", "name": "book", "fields": [
      { "id": "fld_book_author", "name": "author", "type": "reference", "target": "ent_author", "required": true },
      { "id": "fld_book_title", "name": "title", "type": "text", "required": true }
    ]}
  ]
}`

// setupApp writes manifest.json plus any data/<entity>.json files under a
// fresh temp app dir, boots it through registry.Load (which never seeds
// itself), and returns the resulting *registry.RegisteredApp for the test to
// call seed.Apply against directly.
func setupApp(t *testing.T, manifest string, dataFiles map[string]string) *registry.RegisteredApp {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "library")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if len(dataFiles) > 0 {
		dataDir := filepath.Join(dir, "data")
		if err := os.MkdirAll(dataDir, 0o755); err != nil {
			t.Fatal(err)
		}
		for name, body := range dataFiles {
			if err := os.WriteFile(filepath.Join(dataDir, name), []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	reg, results, err := registry.Load(root, root)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	t.Cleanup(func() { reg.Close() })
	for _, r := range results {
		if !r.OK {
			t.Fatalf("app did not load: %v %v", r.Errors, r.Err)
		}
		if !r.Fresh {
			t.Fatalf("expected a freshly created database")
		}
	}
	ra, ok := reg.App("library")
	if !ok {
		t.Fatal("library not registered")
	}
	return ra
}

func rowCount(t *testing.T, ra *registry.RegisteredApp, entity string) int {
	t.Helper()
	ent := ra.Schema.Entity(entity)
	_, total, err := ra.Store.List(ent, store.ListQuery{Limit: 1000})
	if err != nil {
		t.Fatalf("list %s: %v", entity, err)
	}
	return total
}

func TestApplyNoDataDir(t *testing.T) {
	ra := setupApp(t, libraryManifest, nil)
	seeded, err := seed.Apply(ra)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if seeded {
		t.Fatal("expected seeded=false when there is no data/ dir")
	}
	if n := rowCount(t, ra, "author"); n != 0 {
		t.Fatalf("expected no authors, got %d", n)
	}
}

func TestApplySingleEntity(t *testing.T) {
	ra := setupApp(t, libraryManifest, map[string]string{
		"author.json": `[{"name": "J.R.R. Tolkien"}]`,
	})
	seeded, err := seed.Apply(ra)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !seeded {
		t.Fatal("expected seeded=true")
	}
	if n := rowCount(t, ra, "author"); n != 1 {
		t.Fatalf("expected 1 author, got %d", n)
	}
}

func TestApplyCrossEntityReference(t *testing.T) {
	ra := setupApp(t, libraryManifest, map[string]string{
		"author.json": `[{"$key": "tolkien", "name": "J.R.R. Tolkien"}]`,
		"book.json": `[
			{"author": "$author.tolkien", "title": "The Hobbit"},
			{"author": "$author.tolkien", "title": "The Lord of the Rings"}
		]`,
	})
	if _, err := seed.Apply(ra); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	authorEnt := ra.Schema.Entity("author")
	rows, total, err := ra.Store.List(authorEnt, store.ListQuery{Limit: 1000})
	if err != nil || total != 1 {
		t.Fatalf("expected 1 author, got %d (err=%v)", total, err)
	}
	authorID := rows[0]["id"].(string)

	bookEnt := ra.Schema.Entity("book")
	books, total, err := ra.Store.List(bookEnt, store.ListQuery{Limit: 1000})
	if err != nil || total != 2 {
		t.Fatalf("expected 2 books, got %d (err=%v)", total, err)
	}
	for _, b := range books {
		if b["author"] != authorID {
			t.Fatalf("book %v did not resolve to author id %q", b, authorID)
		}
	}
}

func TestApplyUnknownFilename(t *testing.T) {
	ra := setupApp(t, libraryManifest, map[string]string{
		"nonexistent.json": `[{"whatever": true}]`,
	})
	if _, err := seed.Apply(ra); err == nil {
		t.Fatal("expected an error for a seed file with no matching entity")
	}
	if n := rowCount(t, ra, "author"); n != 0 {
		t.Fatalf("expected no rows inserted, got %d authors", n)
	}
}

func TestApplyBadReferenceRollsBackEverything(t *testing.T) {
	ra := setupApp(t, libraryManifest, map[string]string{
		"author.json": `[{"$key": "tolkien", "name": "J.R.R. Tolkien"}]`,
		"book.json":   `[{"author": "$author.someone-else", "title": "The Hobbit"}]`,
	})
	if _, err := seed.Apply(ra); err == nil {
		t.Fatal("expected an error for an unresolved reference placeholder")
	}
	if n := rowCount(t, ra, "author"); n != 0 {
		t.Fatalf("expected the author insert to be rolled back too, got %d authors", n)
	}
	if n := rowCount(t, ra, "book"); n != 0 {
		t.Fatalf("expected no books, got %d", n)
	}
}
