// Command pocketknife is the single generic server plus the headless
// migration engine. With no subcommand it scans the catalog directory,
// validates and materializes each manifest, registers the compiled schemas,
// and serves the schema-driven API and MCP tools over one origin. The
// "migrate" subcommand evolves one app's schema to a new manifest version
// without losing data.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"runtime/debug"
	"strings"

	"pocketknife/api"
	"pocketknife/cors"
	"pocketknife/mcpserver"
	"pocketknife/migrate"
	"pocketknife/registry"
	"pocketknife/seed"
	"pocketknife/validateapi"
)

func main() {
	loadDotEnv(".env")
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "migrate":
			runMigrate(os.Args[2:])
			return
		}
	}
	runServe(os.Args[1:])
}

// loadDotEnv reads path as KEY=VALUE lines (blank lines and #-comments
// ignored, values may be quoted) and calls os.Setenv for any key not already
// present in the environment, so an explicit `FOO=bar ./pocketknife` always
// wins over the file. A missing file is not an error: config may come from
// the environment directly (e.g. under systemd/docker, or in production
// where no .env ships alongside the binary).
func loadDotEnv(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, val)
		}
	}
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	catalogDir := fs.String("catalog", "catalog", "directory containing <app_id>/manifest.json")
	dataDir := fs.String("data", "data", "directory containing <app_id>/data.db")
	addr := fs.String("addr", "127.0.0.1:8080", "address to listen on (127.0.0.1-only by default: the Workbench v0.1 runtime assumes a trusted local machine; pass e.g. -addr :8080 to bind every interface, an explicit choice to expose it to a network)")
	corsEnabled := fs.Bool("cors", false, "allow cross-origin requests (for a frontend served by a separate dev server)")
	_ = fs.Parse(args)

	reg, results, err := registry.Load(*catalogDir, *dataDir)
	if err != nil {
		log.Fatalf("boot failed: %v", err)
	}
	defer reg.Close()

	for _, res := range results {
		switch {
		case res.OK:
			log.Printf("registered app %q from %s", res.AppID, res.ManifestPath)
		case len(res.Errors) > 0:
			log.Printf("SKIPPED %s — manifest failed validation:", res.ManifestPath)
			for _, e := range res.Errors {
				log.Printf("    %s", e.String())
			}
		case res.Err != nil:
			log.Printf("SKIPPED %s — %v", res.ManifestPath, res.Err)
		}
	}

	// Seed starter data from catalog/<id>/data/, but only for an app whose
	// data.db this boot just created. A seed failure un-registers the app
	// rather than serving it partially seeded — the same hard-gate posture
	// registry.Load already applies to an invalid manifest.
	for _, res := range results {
		if !res.OK || !res.Fresh {
			continue
		}
		ra, ok := reg.App(res.AppID)
		if !ok {
			continue
		}
		seeded, err := seed.Apply(ra)
		if err != nil {
			log.Printf("SKIPPED app %q — seed data failed: %v", res.AppID, err)
			ra.Store.Close()
			reg.Unregister(res.AppID)
			continue
		}
		if seeded {
			log.Printf("seeded starter data for app %q", res.AppID)
		}
	}

	if len(reg.Apps()) == 0 {
		log.Printf("warning: no apps registered; serving an empty runtime")
	}

	mux := http.NewServeMux()
	mux.Handle("/apps/", api.NewServer(reg))
	mux.Handle("/mcp/", mcpserver.NewServer(reg))
	mux.Handle("/validate", validateapi.NewServer())

	handler := recoverMiddleware(cors.Middleware(*corsEnabled, mux))
	log.Printf("pocketknife listening on %s (catalog dir: %s, data dir: %s)", *addr, *catalogDir, *dataDir)
	if err := http.ListenAndServe(*addr, handler); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// recoverMiddleware catches a panic from any handler and turns it into a
// plain 500, so a bug in one request can never take down the whole process —
// every other app being served by this one binary must keep working. The
// panic value and a stack trace go to the server log only; the client never
// sees more than a bare status code.
func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic serving %s %s: %v\n%s", r.Method, r.URL.Path, rec, debug.Stack())
				w.WriteHeader(http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// runMigrate drives the apply-changeset flow for one app. The app's current
// on-disk manifest is the "old" side; -to names the proposed next version. A
// destructive migration needs -confirm and, where required, witnesses supplied
// via a -witnesses JSON file (keyed by stable field id).
func runMigrate(args []string) {
	fs := flag.NewFlagSet("migrate", flag.ExitOnError)
	catalogDir := fs.String("catalog", "catalog", "directory containing <app_id>/manifest.json")
	dataDir := fs.String("data", "data", "directory containing <app_id>/data.db")
	appID := fs.String("app", "", "id of the app to migrate (required)")
	toPath := fs.String("to", "", "path to the new manifest.json (required)")
	confirm := fs.Bool("confirm", false, "confirm destructive operations")
	witnessPath := fs.String("witnesses", "", "path to a JSON file of witnesses keyed by field id")
	_ = fs.Parse(args)

	if *appID == "" || *toPath == "" {
		log.Fatalf("usage: pocketknife migrate -app <id> -to <new_manifest.json> [-confirm] [-witnesses <file.json>]")
	}

	reg, _, err := registry.Load(*catalogDir, *dataDir)
	if err != nil {
		log.Fatalf("boot failed: %v", err)
	}
	defer reg.Close()

	newBytes, err := os.ReadFile(*toPath)
	if err != nil {
		log.Fatalf("read new manifest: %v", err)
	}

	opts := migrate.Options{Confirm: *confirm}
	if *witnessPath != "" {
		wb, err := os.ReadFile(*witnessPath)
		if err != nil {
			log.Fatalf("read witnesses: %v", err)
		}
		if err := json.Unmarshal(wb, &opts.Witnesses); err != nil {
			log.Fatalf("parse witnesses %s: %v", *witnessPath, err)
		}
	}

	res, err := migrate.Apply(context.Background(), reg, *appID, newBytes, opts)
	if res != nil && res.Changeset != nil && !res.NoChange {
		printChangeset(res.Changeset)
	}
	if err != nil {
		log.Fatalf("%v", err)
	}
	if res.NoChange {
		log.Printf("no changes: %q is already at the target schema", *appID)
		return
	}
	if res.SnapshotPath != "" {
		log.Printf("snapshot saved at %s", res.SnapshotPath)
	}
	log.Printf("migration applied: %q is now at version %d", *appID, res.Changeset.ToVersion)
}

func printChangeset(cs *migrate.Changeset) {
	log.Printf("changeset for %q (v%d -> v%d): %d operation(s)", cs.AppID, cs.FromVersion, cs.ToVersion, len(cs.Ops))
	for _, op := range cs.Ops {
		log.Printf("    %s", op.String())
	}
}
